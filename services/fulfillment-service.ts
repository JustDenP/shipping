import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import {
    Channel,
    ChannelService,
    ConfigService,
    Ctx,
    CustomFulfillmentFields,
    EntityHydrator,
    EntityNotFoundError,
    Fulfillment,
    FulfillmentLine,
    FulfillmentService,
    GlobalSettingsService,
    HistoryService,
    ID,
    IllegalOperationError,
    InternalServerError,
    isGraphQlErrorResult,
    Logger,
    Order,
    OrderLine,
    OrderService,
    OrderState,
    PaginatedList,
    RequestContext,
    TransactionalConnection,
    User,
} from '@vendure/core';
import IORedis, { Redis } from 'ioredis';

import { CarrierMetadata, IError, IRate, IRefund, ITracker, Shipment, Tracker } from '@easypost/api';
import hash from 'object-hash';
import { easyPostFulfillmentHandler } from '../fulfillment-handler';
import { EasyPostPluginConfig, ShippingTaxCalculationStrategy } from '../plugin';
import { EasyPostWebhookEvent, getEasyPostClient, retrieveStatelessRates } from './easypost';
import {
    formatShipServiceName,
    fulfillmentToEasyPostShipment,
    isValidShippingAddress,
    orderToEasyPostShipment,
} from './utils';
import { FulfillmentHistoryEntryData } from '../extend/historyService-extend';
import { HistoryEntryType, UpdateFulfillmentShippingDetailsInput } from '../../codegen/generated-admin-types';
import { HydrateOptions } from '@vendure/core/dist/service/helpers/entity-hydrator/entity-hydrator-types';

const objectHash = (obj: any) => hash(obj, { algorithm: 'sha256' });

const excludeNames = [/ddp/i, /next day/i, /overnight/i, /air am/i, /\(AM\)/];

const addedFeeMap = {
    ca_8230d300a7ec47fb95eb74360be8ad66: 3, // for ePost Global add $3
};

const carrierEnableCheck = {
    ca_cb80688371b442bb81c8a55e932ea9f7: (order: Order) => {
        return order.shippingAddress.countryCode === 'US';
    },
};

let globalRedisClient: Redis | undefined;
let globalRedisNameSpace = 'easypost-cache';

const carrierAliases: Record<string, string> = {
    ups: 'upsdap',
    fedex: 'fedexdefault',
};

type CarrierInfoMap = Record<string, CarrierMetadata>;

export const carrierNames: Record<string, string> = {
    ups: 'UPS',
    upsdap: 'UPS',
    fedex: 'FedEx',
    fedexdefault: 'FedEx',
    usps: 'USPS',
    dhlexpress: 'DHL Express',
};

const forbiddenServices: Record<string, string[]> = {
    ups: ['UPSStandard'],
    upsdap: ['UPSStandard'],
};

export interface ServiceRate {
    id?: string; // included when getting rates for an actual shipment
    serviceCode: string;
    serviceName: string;
    // these three are in dollars, not cents, because the frontend expects that
    // currently and it would be a pain to coordinate a rollout that doesn't
    // leave some users in a state where it expects dollars but now has cents, etc.
    shipmentCost: number; // raw shipping rate in dollars (aka rateCost / 100)
    otherCost: number; // amount to collect for insurance in dollars
    insuranceCost: number; // amount we'll pay for insurance in dollars
    currency: string;
    carrierDeliveryDate?: string;
    carrierDeliveryGuarantee: boolean;
}

export interface CarrierWithRates {
    id: string;
    code: string;
    name: string;
    nickname: string;
    services: ServiceRate[];
}

function getLineValue(lines: FulfillmentLine[] | OrderLine[]) {
    // Sum the value of all items in the fulfillment
    let total = 0;
    for (const line of lines) {
        if ((line as FulfillmentLine).orderLine) {
            total += (line as FulfillmentLine).quantity * (line as FulfillmentLine).orderLine.unitPrice;
        } else {
            total += (line as OrderLine).quantity * (line as OrderLine).unitPrice;
        }
    }
    return total;
}

export const nonPendingFulfillmentStates = ['Created', 'OnHold', 'Cancelled'];
export const ActiveUnpurchasedFulfillmentStates = ['Created', 'Pending', 'OnHold'];
export const ActiveFulfillmentStates = ['Purchased', 'Tendered', 'Shipped', 'Delivered'];

// These are the states an order must be in for us to automatically change the state based on its fulfillments
const ActivePlacedOrderStates = [
    'PaymentSettled',
    'OnHold',
    'PartiallyShipped',
    'Shipped',
    'PartiallyDelivered',
];

@Injectable()
export class EasyPostFulfillmentService implements OnApplicationBootstrap {
    private shipTaxStrategy: ShippingTaxCalculationStrategy = null;

    private get redisNamespace() {
        return globalRedisNameSpace;
    }
    private redisExpireSeconds = 60 * 30; // 30 minutes

    constructor(
        private hydrator: EntityHydrator,
        private orderService: OrderService,
        private connection: TransactionalConnection,
        private fulfillmentService: FulfillmentService,
        private globalSettingsService: GlobalSettingsService,
        private historyService: HistoryService,
        private readonly channelService: ChannelService,
        private readonly configService: ConfigService,
    ) {}

    setShippingTaxStrategy(strategy: ShippingTaxCalculationStrategy) {
        this.shipTaxStrategy = strategy;
    }

    private hashKey(object: Record<string, any>): string {
        return `${this.redisNamespace}:${objectHash(object)}`;
    }

    async getCache<T>(object: Record<string, any>): Promise<T | undefined> {
        if (!globalRedisClient) {
            return;
        }
        const key = this.hashKey(object);
        const cached = await globalRedisClient.get(key);
        Logger.debug(`Cache ${cached ? 'hit' : 'miss'} for ${key}`, 'EasyPostService');
        if (cached) {
            return JSON.parse(cached);
        }
    }

    async saveCache(object: Record<string, any>, data: any, expireSeconds?: number): Promise<void> {
        if (!globalRedisClient) {
            return;
        }
        if (expireSeconds === undefined) {
            expireSeconds = this.redisExpireSeconds;
        }
        const key = this.hashKey(object);
        Logger.debug(`Saving cache for ${key}`, 'EasyPostService');
        await globalRedisClient.set(key, JSON.stringify(data), 'EX', expireSeconds);
    }

    async clearCache(object: Record<string, any>): Promise<void> {
        if (!globalRedisClient) {
            return;
        }
        const key = this.hashKey(object);
        Logger.debug(`Clearing cache for ${key}`, 'EasyPostService');
        await globalRedisClient.del(key);
    }

    async clearAllCache(): Promise<void> {
        if (!globalRedisClient) {
            Logger.warn('Redis client not initialized, no cache to clear', 'EasyPostService');
            return;
        }

        try {
            // Get all keys matching the namespace pattern
            const pattern = `${this.redisNamespace}:*`;
            let cursor = '0';
            let keys: string[] = [];

            // Use SCAN instead of KEYS to avoid blocking Redis
            do {
                const [nextCursor, scanKeys] = await globalRedisClient.scan(
                    cursor,
                    'MATCH',
                    pattern,
                    'COUNT',
                    100,
                );
                cursor = nextCursor;
                keys = keys.concat(scanKeys);
            } while (cursor !== '0');

            if (keys.length > 0) {
                // Delete all found keys
                await globalRedisClient.del(...keys);
                Logger.debug(
                    `Cleared ${keys.length} EasyPost cache entries with pattern ${pattern}`,
                    'EasyPostService',
                );
            } else {
                Logger.debug('No EasyPost cache entries found to clear', 'EasyPostService');
            }
        } catch (error) {
            Logger.error(`Failed to clear EasyPost cache: ${error.message}`, 'EasyPostService', error.stack);
            throw new Error(`Failed to clear EasyPost cache: ${error.message}`);
        }
    }

    initializeCache(config: EasyPostPluginConfig): void {
        if (config?.redisOptions) {
            globalRedisNameSpace = config.redisNamespace || this.redisNamespace;
            globalRedisClient = new IORedis(config.redisOptions);
            globalRedisClient.on('error', err =>
                Logger.error(err.message, 'EasyPostService-redis', err.stack),
            );
        }
    }

    async recordHistory<T extends keyof FulfillmentHistoryEntryData>(
        ctx: RequestContext,
        fulfillmentId: ID,
        type: T,
        data: FulfillmentHistoryEntryData[T],
        isPublic = false,
    ) {
        return this.historyService.createHistoryEntryForFulfillment(
            {
                ctx,
                fulfillmentId,
                type, // Convert from string to enum
                data,
            },
            isPublic,
        );
    }

    async lookupSalesTaxForShipping(ctx: RequestContext, order: Order, shippingRate: number) {
        if (this.shipTaxStrategy) {
            return await this.shipTaxStrategy.calculateShippingTax({
                order,
                shippingAmount: shippingRate,
                ctx,
            });
        } else {
            return 0;
        }
    }

    async onApplicationBootstrap(): Promise<void> {
        const channel = await this.connection.rawConnection.getRepository(Channel).findOne({
            where: { code: '__default_channel__' },
            relations: ['defaultTaxZone', 'defaultShippingZone'],
        });
        if (!channel) {
            throw new Error('Default channel not found');
        }
        // const ctx = new RequestContext({
        //     apiType: 'admin',
        //     channel: channel,
        //     isAuthorized: true,
        //     authorizedAsOwnerOnly: true,
        //     languageCode: channel.defaultLanguageCode,
        // });
    }

    async getCarrierInfo(): Promise<CarrierInfoMap> {
        try {
            const cacheKey = { carrierTypes: 'easypost' };

            const cached = await this.getCache<CarrierInfoMap>(cacheKey);
            if (cached) {
                return cached;
            }

            const epCli = getEasyPostClient();
            const carriers: CarrierMetadata[] = (await epCli.CarrierMetadata.retrieve([], [])) as any;
            const carrierMap: CarrierInfoMap = {};

            for (const carrier of carriers) {
                const cName = (<any>carrier).name?.toLowerCase() ?? '';
                carrierMap[cName] = carrier;
                if (carrierAliases[cName]) {
                    carrierMap[carrierAliases[cName]] = carrier;
                }
            }

            this.saveCache(cacheKey, carrierMap, 15 * 60);

            return carrierMap;
        } catch (e) {
            Logger.error(`Error getting carrier info from EasyPost: ${e.message || e}`);
            return {};
        }
    }

    async getRawShippingRatesForFulfillment(
        @Ctx() ctx: RequestContext,
        fulfillment: Fulfillment,
    ): Promise<IRate[] | null> {
        try {
            if (!isValidShippingAddress(fulfillment.orders[0].shippingAddress)) {
                throw new Error('Shipping address not found');
            } else if (fulfillment.customFields.ratePurchasedAt) {
                throw new Error('Shipping has already been purchased');
            }

            await this.hydrateFulfillmentForShippingInfo(ctx, fulfillment);
            const easyPostShipment = fulfillmentToEasyPostShipment(fulfillment);
            const cacheKey = { epRates: easyPostShipment };
            const cached = await this.getCache<IRate[]>(cacheKey);
            if (cached) {
                return cached;
            }

            const rates = await retrieveStatelessRates(easyPostShipment);
            // this is only used when we are manually updating shipping info, so don't cache it for long
            await this.saveCache(cacheKey, rates, 60);

            return rates;
        } catch (e: any) {
            Logger.warn(`Error getting rates: ${e.message || e}`);
            return null;
        }
    }

    /** Used by admin ui when selecting shipping rates for a fulfillment */
    async getShippingRatesForFulfillment(
        @Ctx() ctx: RequestContext,
        id: ID,
    ): Promise<CarrierWithRates[] | null> {
        try {
            const fulfillment = await this.connection.getRepository(ctx, Fulfillment).findOne({
                where: { id },
                relations: this.fulfillmentNeededRelations,
            });
            if (!fulfillment) {
                throw new Error('Fulfillment not found');
            }
            const [carrierMap, rates] = await Promise.all([
                this.getCarrierInfo(),
                this.getRawShippingRatesForFulfillment(ctx, fulfillment),
            ]);

            const productValue = getLineValue(fulfillment.lines);
            const carrierRates = await this.toCarrierRatesList(
                ctx,
                carrierMap,
                rates,
                productValue,
                fulfillment.orders[0],
            );
            return carrierRates;
        } catch (e: any) {
            Logger.warn(`Error getting rates: ${e.message || e}`);
            return null;
        }
    }
    async getRatesForUnfulfilledOrder(
        @Ctx() ctx: RequestContext,
        order: Order,
    ): Promise<CarrierWithRates[] | null> {
        // Get full order with needed relations
        await this.hydrator.hydrate(ctx, order, {
            relations: [
                'lines',
                'lines.productVariant',
                'lines.productVariant.product',
                'fulfillments',
                'fulfillments.lines',
            ],
        });

        // this only happens when we're selecting shipping for an order, which means any
        // unpurchased fulfillment shipping info is basically invalid; just cancel them
        const unpurchasedFulfillments = order.fulfillments.filter(
            f => f.state === 'Created' || f.state === 'Pending' || f.state === 'OnHold',
        );
        await Promise.all(
            unpurchasedFulfillments.map(f =>
                this.orderService.transitionFulfillmentToState(ctx, f.id, 'Cancelled'),
            ),
        );
        unpurchasedFulfillments.forEach(f => (f.state = 'Cancelled')); // so they're filtered out in the next step

        // Calculate remaining unfulfilled quantities for each order line
        const unfulfilledLines = order.lines
            .map(line => {
                const fulfilledQuantity = order.fulfillments
                    .filter(f => f.state !== 'Cancelled') // count quantity used by any non-cancelled fufillments (the product goes away if they get finished)
                    .flatMap(f => f.lines)
                    .filter(fl => fl.orderLineId === line.id)
                    .reduce((sum, fl) => sum + fl.quantity, 0);

                return {
                    ...line,
                    quantity: line.quantity - fulfilledQuantity,
                } as OrderLine;
            })
            .filter(line => line.quantity > 0);

        if (unfulfilledLines.length === 0) {
            throw new Error(`Order ${order.code} has no unfulfilled items`);
        }

        // Create a temporary order object with only unfulfilled items
        const tempOrder = {
            ...order,
            lines: unfulfilledLines,
        };

        try {
            const [carrierMap, rates] = await Promise.all([
                this.getCarrierInfo(),
                this.getRawShippingRates(ctx, tempOrder),
            ]);

            const productValue = getLineValue(unfulfilledLines);
            return await this.toCarrierRatesList(ctx, carrierMap, rates, productValue, order);
        } catch (e: any) {
            Logger.warn(`Error getting unfulfilled rates: ${e.message || e}`);
            return null;
        }
    }

    get fulfillmentNeededRelations() {
        return [
            'orders',
            'orders.lines', // TODO: do we really need this?
            'lines.orderLine',
            'lines.orderLine.productVariant',
            'lines.orderLine.productVariant.product',
            'lines.orderLine.productVariant.translations',
        ] satisfies HydrateOptions<Fulfillment>['relations'];
    }

    async hydrateFulfillmentForShippingInfo(ctx, fulfillment: Fulfillment) {
        await this.hydrator.hydrate(ctx, fulfillment, {
            relations: this.fulfillmentNeededRelations,
        });
    }

    async getRawShippingRates(
        @Ctx() ctx: RequestContext,
        order: Pick<Order, 'shippingAddress' | 'lines' | 'customer' | 'code'>,
    ): Promise<IRate[] | null> {
        try {
            if (!isValidShippingAddress(order?.shippingAddress)) {
                Logger.debug("Trying to get shipping rates without adequate 'to' address information");
                return null;
            }

            const easyPostShipment = orderToEasyPostShipment(order);
            const cacheKey = { epRates: easyPostShipment };
            const cached = await this.getCache<IRate[]>(cacheKey);
            if (cached) {
                return cached;
            }

            const rates = await retrieveStatelessRates(easyPostShipment);
            await this.saveCache(cacheKey, rates);
            if (!rates?.length) {
                console.warn('No rates found for order', order.code, easyPostShipment);
            }
            return rates;
        } catch (e: any) {
            Logger.warn(`Error getting rates: ${e.message || e}`);
            return null;
        }
    }

    /** Used by shop api when quoting shipping rates to customer */
    async getShippingRates(@Ctx() ctx: RequestContext, order: Order): Promise<CarrierWithRates[] | null> {
        try {
            const [carrierMap, rates] = await Promise.all([
                this.getCarrierInfo(),
                this.getRawShippingRates(ctx, order),
            ]);

            return await this.toCarrierRatesList(ctx, carrierMap, rates, order.subTotal, order);
        } catch (e: any) {
            Logger.warn(`Error getting rates: ${e.message || e}`);
            return null;
        }
    }

    /**
     * Converts a raw list of EasyPost rates into a list of CarrierWithRates
     * @param carrierMap Map of carrier information to use to normalize names
     * @param rates the array of rates returned from EasyPost
     * @param lineItemValueCents value in cents of all items in the shipment (used to calculate insurance)
     * @returns
     */
    async toCarrierRatesList(
        ctx: RequestContext,
        carrierMap: CarrierInfoMap,
        rates: IRate[],
        lineItemValueCents = 0,
        order: Order,
    ): Promise<CarrierWithRates[]> {
        if (!rates?.length) {
            throw new Error('No rates found');
        }

        const rateList: CarrierWithRates[] = [];
        for (const rate of rates) {
            const baseRate = parseFloat(rate.rate);
            const baseRateCents = Math.round(baseRate * 100);
            const rateDollars = baseRate + (addedFeeMap[rate.carrier_account_id] || 0);
            const rateCents = Math.round(rateDollars * 100);

            if (
                rate.carrier_account_id in carrierEnableCheck &&
                !carrierEnableCheck[rate.carrier_account_id](order)
            ) {
                continue; // Carrier disabled for this order
            }

            if (baseRateCents < 5) {
                // Skip rates that are too low to be useful; these are probably broken or placeholders,
                // which is what epost global has
                continue;
            }
            const cCode = rate.carrier.toLowerCase();
            let carrier = rateList.find(c => c.code === cCode);
            const carrierInfo = carrierMap[cCode];

            const carrierName = carrierNames[cCode] || carrierInfo?.human_readable || rate.carrier;

            if (cCode in forbiddenServices && forbiddenServices[cCode].includes(rate.service)) {
                continue;
            }

            if (!carrier) {
                carrier = {
                    id: rate.carrier_account_id,
                    code: cCode,
                    name: carrierName,
                    services: [],
                    nickname: rate.carrier,
                };
                rateList.push(carrier);
            }

            if (rate.currency.toLowerCase() !== 'usd') {
                Logger.warn('Currency is not USD: ' + JSON.stringify(rate, null, 2));
                continue;
            }

            const serviceInfo: any = carrierInfo?.service_levels?.find(
                (l: any) => l.name.toLowerCase() === rate.service.toLowerCase(),
            );
            const serviceName = formatShipServiceName(
                serviceInfo?.human_readable || rate.service,
                carrierName,
            );
            if (excludeNames.some(re => re.test(serviceName))) {
                // Skip this one
                continue;
            }
            const insurance = await this.calculateInsurance(ctx, lineItemValueCents + rateCents);
            carrier.services.push({
                id: rate.id,
                serviceCode: rate.service.toLowerCase(),
                serviceName,
                shipmentCost: rateDollars,
                otherCost: insurance.amountToCollect / 100,
                insuranceCost: insurance.insuranceCost / 100,
                currency: rate.currency,
                carrierDeliveryDate: rate.delivery_date,
                carrierDeliveryGuarantee: !!rate.delivery_date_guaranteed,
            });
        }

        return rateList.filter(r => r.services.length);
    }

    capitalizeFirstLetter(string) {
        return string.charAt(0).toUpperCase() + string.slice(1);
    }

    /** Calculates the shipping amount actually charged to the customer, including carrier rate + insurance */
    async getOrderShippingRate(
        @Ctx() ctx: RequestContext,
        theOrder: Order,
        carrierCode: string,
        serviceCode: string,
    ): Promise<number> {
        const order = await this.orderService.findOne(ctx, theOrder.id, [
            'lines',
            'lines.productVariant',
            'lines.productVariant.product',
            'lines.taxCategory',
        ]);

        if (!order) {
            throw new Error('Order not found');
        }
        const theRates = await this.getShippingRates(ctx, order);

        const carrier = theRates?.find(c => c.code === carrierCode);
        if (!carrier) {
            return 0;
        }

        // @TODO: do we need (or even want) this? It should be set when the carrier is chosen,
        // not a byproduct of calculating after choosing
        await this.orderService.updateCustomFields(ctx, theOrder.id, {
            carrierId: carrier.id,
        });

        const service = carrier.services.find((s: { serviceCode: string }) => s.serviceCode === serviceCode);
        if (!service) {
            return 0;
        }

        // console.log('Chosen service:', service);
        // otherCost is the amount that would be collected for insurance, not the amount we may pay;
        // include the full amount of otherCost because this is used to calculate the final shipping
        // amount the customer will pay and be taxed on
        const finalRate = service?.shipmentCost + (service?.otherCost || 0);
        if (isNaN(finalRate)) {
            throw new Error('Invalid rate returned: ' + JSON.stringify(service));
        }
        console.log('Shipping rate:', Math.round(finalRate * 100));
        return Math.round(finalRate * 100); // Return in cents
    }

    async specificCodeShipments(ctx: RequestContext, carrierCode: string): Promise<PaginatedList<Order>> {
        const shipments = this.connection.getRepository(ctx, Order);

        const [items, totalItems] = await shipments.findAndCount({
            where: {
                customFields: {
                    carrierCode,
                },
            },
        });

        return {
            items,
            totalItems,
        };
    }

    async updateShippingDetails(
        ctx: RequestContext,
        fulfillment: Fulfillment,
        input: UpdateFulfillmentShippingDetailsInput,
    ) {
        // This is only allowed for active / unpurchased fulfillments
        if (!ActiveUnpurchasedFulfillmentStates.includes(fulfillment.state)) {
            throw new Error(`Invalid state for updating shipping details: ${fulfillment.state}`);
        }
        const id = fulfillment.id;
        const curService = `${fulfillment.customFields.carrierCode}:${fulfillment.customFields.serviceCode}`;
        const curRate = fulfillment.customFields.rateCost;
        const newService = `${input.carrierCode}:${input.serviceCode}`;
        const newRate = input.rateCost;

        // Since we may go as far as switching carriers, clear out the old shipmentId
        // and get back into the Created state if currently Pending (force new shipment)
        const customFields: Partial<CustomFulfillmentFields> = { ...input };
        if (fulfillment.state === 'Pending') {
            await this.fulfillmentService.transitionToState(ctx, id, 'Created');
            customFields.shipmentId = null;
            customFields.ratePurchasedAt = null;
            customFields.insuranceCost = customFields.insuranceCost || null;
            customFields.rateId = customFields.rateId || null;
        }
        await this.connection.getRepository(ctx, Fulfillment).update(id, {
            customFields,
        });

        if (curService !== newService) {
            await this.recordHistory(ctx, id, HistoryEntryType.FulfillmentServiceChangeEvent, {
                rate: newRate,
                service: newService,
                old_rate: curRate,
                old_service: curService,
            });
        }
    }

    async createShipment(ctx: RequestContext, fulfillment: Fulfillment): Promise<any> {
        await this.hydrateFulfillmentForShippingInfo(ctx, fulfillment);
        const order1 = fulfillment.orders[0];

        // If the fulfillment doesn't specify service info, try to get it from the order.
        // This can happen if a fulfillment is created for an order before shipping info is set.
        const carrierId = fulfillment.customFields.carrierId || order1.customFields.carrierId;
        const serviceCode = fulfillment.customFields.serviceCode || order1.customFields.serviceCode;
        if (!carrierId || !serviceCode) {
            throw new Error('CarrierId and ServiceCode are required to create a shipment');
        }

        const easyPostShipment = fulfillmentToEasyPostShipment(fulfillment);
        if (order1.customFields.deliveryInstructions) {
            easyPostShipment.options.handling_instructions = order1.customFields.deliveryInstructions;
        }

        // create the shipment in EasyPost and save its ID, but don't buy it yet
        const epCli = getEasyPostClient();
        const shipment: Shipment = await epCli.Shipment.create({
            carrier_accounts: [carrierId],
            ...easyPostShipment,
        });
        const rate = shipment.rates.find(
            r => r.carrier_account_id === carrierId && r.service.toLowerCase() === serviceCode,
        );
        if (!rate) {
            throw new Error(
                `Rate not found for carrier ${fulfillment.customFields.carrierCode} (${carrierId}) and service ${serviceCode}`,
            );
        }
        const fulfillmentValue = getLineValue(fulfillment.lines);
        const rateCents = Math.round(Number(rate.rate) * 100);
        const insurance = await this.calculateInsurance(ctx, fulfillmentValue + rateCents);
        if (rateCents + insurance.amountToCollect > order1.shipping) {
            console.warn(
                `Shipping rate is higher than expected: Order=${order1.code}, Rate=${rateCents} > ${order1.shippingWithTax}`,
            );
        }
        this.recordHistory(ctx, fulfillment.id, HistoryEntryType.FulfillmentShipmentCreatedEvent, {
            shipment_id: shipment.id,
            rate_id: rate.id,
            rate_cost: rateCents,
            carrier: carrierId,
            service: serviceCode,
            insuranceCost: insurance.insuranceCost,
        });

        fulfillment.customFields.shipmentId = shipment.id;
        fulfillment.customFields.rateId = rate.id;
        fulfillment.customFields.rateCost = rateCents;
        fulfillment.customFields.insuranceCost = insurance.insuranceCost;
        await this.connection.getRepository(ctx, Fulfillment).update(fulfillment.id, {
            customFields: fulfillment.customFields,
        });

        return shipment;
    }

    async purchaseShipment(ctx: RequestContext, fulfillment: Fulfillment): Promise<Shipment> {
        if (fulfillment.trackingCode) {
            throw new Error('Shipment has already been purchased');
        } else if (!fulfillment.customFields.rateId) {
            throw new Error('Shipping rate not yet selected');
        }

        await this.hydrator.hydrate(ctx, fulfillment, {
            relations: ['lines.orderLine'],
        });

        const totalItemValue = getLineValue(fulfillment.lines);
        let rateCost = fulfillment.customFields.rateCost || 0;
        const insurance = await this.calculateInsurance(ctx, totalItemValue + rateCost);

        fulfillment.customFields.ratePurchasedAt = new Date();
        const epCli = getEasyPostClient();
        try {
            const purchasedShipment = await epCli.Shipment.buy(
                fulfillment.customFields.shipmentId,
                fulfillment.customFields.rateId,
                ...(insurance.valueToInsure ? [insurance.valueToInsure / 100] : []), // dollars
            );
            rateCost = Math.round(Number(purchasedShipment.selected_rate.rate) * 100);
            fulfillment.trackingCode = purchasedShipment.tracking_code;
            fulfillment.customFields.trackerId = purchasedShipment.tracker.id;
            fulfillment.customFields.labelUrl = purchasedShipment.postage_label.label_url;
            fulfillment.customFields.rateCost = rateCost;
            fulfillment.customFields.insuranceCost = insurance.insuranceCost;
            const commercialInvoice = purchasedShipment.forms.find(f => f.form_type === 'commercial_invoice');
            if (commercialInvoice) {
                fulfillment.customFields.commInvoiceUrl = commercialInvoice.form_url;
                fulfillment.customFields.commInvoiceFiled = commercialInvoice.submitted_electronically;
            }

            await this.recordHistory(ctx, fulfillment.id, HistoryEntryType.FulfillmentPurchasedEvent, {
                rate_id: fulfillment.customFields.rateId,
                carrier: fulfillment.customFields.carrierCode,
                tracking_number: fulfillment.trackingCode,
                label_uri: fulfillment.customFields.labelUrl,
                rate: rateCost,
                insurance: insurance.insuranceCost,
            });

            await this.connection.getRepository(ctx, Fulfillment).update(fulfillment.id, {
                trackingCode: fulfillment.trackingCode,
                customFields: fulfillment.customFields,
            });

            return purchasedShipment;
        } catch (e: any) {
            const msg: string = (e as IError).errors?.[0]?.message ?? e.message ?? e;
            if (msg.indexOf('rate mismatch') !== -1) {
                throw new Error('Rate mismatch -- rates need to be recalculated');
            }
            throw new Error(`EasyPost error: ${msg}`);
        }
    }

    /**
     * Determines how much we'll collect for insurance (otherCost) and how much we'll pay out
     * to EasyPost (insuranceCost) based on the value of the shipment.  We always collect
     * otherCost from the customer, but we only pay insuranceCost to EasyPost when certain
     * thresholds are met.
     *
     * All values returned are in cents.
     *
     * @param ctx
     * @param shipmentValueCents combined value of all items in the shipment + raw cost to ship
     */
    async calculateInsurance(
        ctx: RequestContext,
        shipmentValueCents: number,
    ): Promise<{
        /** how much to collect from the customer */
        amountToCollect: number;
        /** how much to pay for insurance */
        insuranceCost: number;
        /** how much of the shipment's value we should buy insurance for (based on config) */
        valueToInsure: number;
    }> {
        const globalSettings = await this.globalSettingsService.getSettings(ctx);
        // we'll buy insurance for shipments valued at this or higher
        const minimumInsureValue = globalSettings.customFields.insuranceValueMin * 100; // convert to cents
        // how much of the value should we insure (0-100%) -- our cost to replace
        // is less than the cost to the customer, so we probably don't need to insure
        // the full sale value
        const percentValueToInsure = globalSettings.customFields.insureValuePercent / 100; // convert 50 -> 0.5
        // minimum insurable value of $50 per shipment
        const shipmentValue = Math.max(5000, shipmentValueCents);
        // insurance is 1% of the shipment value
        const amountToCollect = Math.max(50, Math.round(shipmentValue * 0.01));
        const shouldPayForInsurance = shipmentValue >= minimumInsureValue;
        const valueToInsure = shouldPayForInsurance ? Math.round(shipmentValue * percentValueToInsure) : 0;
        const insuranceCost = Math.round(valueToInsure * 0.01);

        return {
            amountToCollect,
            insuranceCost,
            valueToInsure,
        };
    }

    async purchaseTracker(ctx: RequestContext, fulfillment: Fulfillment): Promise<Tracker> {
        // Usually we want to silently skip if things aren't in the necessary state.
        // We only purchase trackers for manual fulfillments with a tracking code.
        if (!fulfillment.customFields.treatAsManual || !fulfillment.trackingCode) {
            Logger.info(
                `Not purchasing tracker for fulfillment ${fulfillment.id}; treatAsManual=${fulfillment.customFields.treatAsManual}, trackingCode=${fulfillment.trackingCode}`,
                'EasyPostFulfillmentService',
            );
            return;
        }
        if (fulfillment.customFields.trackerId) {
            Logger.info(`Tracker already set, not purchasing again`, 'EasyPostFulfillmentService');
            return;
        }

        const epCli = getEasyPostClient();
        try {
            const purchasedTracker = await epCli.Tracker.create({
                tracking_code: fulfillment.trackingCode,
                // carrier: ifWeProvidedThisWeCouldMakeItABitMoreReliable,
            });
            const trackerFees =
                purchasedTracker.fees?.reduce((total, fee) => total + Number(fee.amount) * 100, 0) || 0;
            fulfillment.customFields.trackerId = purchasedTracker.id;
            fulfillment.customFields.carrierCode = purchasedTracker.carrier;
            fulfillment.customFields.rateCost = trackerFees;

            await this.recordHistory(ctx, fulfillment.id, HistoryEntryType.FulfillmentPurchasedEvent, {
                rate_id: '',
                carrier: fulfillment.customFields.carrierCode,
                tracking_number: fulfillment.trackingCode,
                label_uri: '',
                rate: trackerFees,
                insurance: 0,
            });

            await this.connection.getRepository(ctx, Fulfillment).save(fulfillment);

            return purchasedTracker;
        } catch (e: any) {
            const msg: string = (e as IError).errors?.[0]?.message ?? e.message ?? e;
            Logger.error(`EasyPost error: ${msg}`, 'EasyPostFulfillmentService');
        }
    }

    async refundShipment(ctx: RequestContext, fulfillmentId: ID): Promise<Shipment> {
        const fulfillment = await this.connection.getEntityOrThrow(ctx, Fulfillment, fulfillmentId);

        if (!fulfillment.customFields.shipmentId) {
            throw new Error('No shipment ID found for this fulfillment');
        }

        if (!fulfillment.trackingCode || !fulfillment.customFields.ratePurchasedAt) {
            throw new Error('No tracking code found - shipment may not have been purchased');
        }

        if (fulfillment.state === 'Cancelled') {
            throw new Error('Cannot refund a cancelled fulfillment');
        }

        try {
            const epClient = getEasyPostClient();
            Logger.info(
                `Refunding shipment ${fulfillment.customFields.shipmentId}`,
                'EasyPostFulfillmentService',
            );
            const response = await epClient.Shipment.refund(fulfillment.customFields.shipmentId);

            // Record the initial refund request
            await this.recordHistory(ctx, fulfillment.id, HistoryEntryType.FulfillmentRefundEvent, {
                shipment_id: fulfillment.customFields.shipmentId,
                status: response.refund_status,
                amount: fulfillment.customFields.rateCost * 100,
            });

            return response;
        } catch (e: any) {
            const msg: string = (e as IError).errors?.[0]?.message ?? e.message ?? e;
            Logger.error(
                `Failed to refund shipment ${fulfillment.customFields.shipmentId}: ${msg}`,
                'EasyPostFulfillmentService',
            );
            throw new Error(`Failed to refund shipment: ${msg}`);
        }
    }

    async shippingLabelScanned(ctx: RequestContext, barcode: string): Promise<Fulfillment> {
        const toTry = trackingNumbersForBarcode(barcode);
        let fulfillment: Fulfillment;
        for (const code of toTry) {
            fulfillment = await this.connection.getRepository(ctx, Fulfillment).findOne({
                where: { trackingCode: code },
                relations: ['easypostPickup', 'orders.customer'],
            });
            if (fulfillment) break;
        }

        if (!fulfillment) {
            throw new EntityNotFoundError('Fulfillment', barcode);
        } else if (fulfillment.customFields.labelScannedAt) {
            throw new IllegalOperationError(
                `Fulfillment was already scanned at ${fulfillment.customFields.labelScannedAt}`,
            );
        }
        fulfillment.customFields.labelScannedAt = new Date();
        await this.connection.getRepository(ctx, Fulfillment).save(fulfillment);
        return fulfillment;
    }

    async undoShippingLabelScan(ctx: RequestContext, fulfillmentId: ID): Promise<Fulfillment> {
        const fulfillment = await this.connection.getEntityOrThrow(ctx, Fulfillment, fulfillmentId, {
            relations: ['easypostPickup', 'orders.customer'],
        });
        if (fulfillment.customFields.labelScannedAt) {
            fulfillment.customFields.labelScannedAt = null;
            fulfillment.easypostPickup = null; // also remove from any Pickup it's part of
            await this.connection.getRepository(ctx, Fulfillment).save(fulfillment);
        }
        return fulfillment;
    }

    async getSuperadminContext() {
        const channel = await this.channelService.getDefaultChannel();
        const { superadminCredentials } = this.configService.authOptions;
        const superAdminUser = await this.connection.rawConnection.getRepository(User).findOneOrFail({
            where: { identifier: superadminCredentials.identifier },
        });

        return new RequestContext({
            channel: channel,
            apiType: 'admin',
            isAuthorized: true,
            authorizedAsOwnerOnly: false,
            session: {
                id: '',
                token: '',
                expires: new Date(),
                cacheExpiry: 999999,
                user: {
                    id: superAdminUser.id,
                    identifier: superAdminUser.identifier,
                    verified: true,
                    channelPermissions: [],
                },
            },
        });
    }

    async registerEasypostWebhook(url: string, secret: string) {
        if (!url) {
            return;
        }

        const epCli = getEasyPostClient();

        // See if the webhook already exists
        const data = await epCli.Webhook.all();

        // const found = data.webhooks.find(wh => wh.url === url);
        // Like above, but do a more intelligent check that will normalize the URL
        const newUrl = new URL(url);
        let found = false;
        for (const wh of data.webhooks) {
            const whUrl = new URL(wh.url);
            if (whUrl.hostname === newUrl.hostname) {
                if (whUrl.pathname === newUrl.pathname) {
                    await epCli.Webhook.update(wh.id, {
                        webhook_secret: secret,
                    });
                    found = true;
                } else {
                    // Matched the hostname but not the path, so delete the old one
                    await epCli.Webhook.delete(wh.id);
                }
            }
        }
        if (!found) {
            await epCli.Webhook.create({
                url,
                webhook_secret: secret,
            });
        }
    }

    async handleRefundEvent(ctx: RequestContext, payload: IRefund) {
        payload.shipment_id;
        const fulfillment = await this.connection.getRepository(ctx, Fulfillment).findOne({
            where: {
                trackingCode: payload.tracking_code,
            },
        });
        if (!fulfillment) {
            return;
        }

        await this.recordHistory(ctx, fulfillment.id, HistoryEntryType.FulfillmentRefundEvent, {
            shipment_id: payload.shipment_id,
            status: payload.status,
        });
    }

    async handleWebhook(hookEvent: EasyPostWebhookEvent): Promise<boolean> {
        const ctx = await this.getSuperadminContext();

        let handled = true;
        switch (hookEvent.description) {
            case 'tracker.created':
            case 'tracker.updated':
                await this.handleTrackerEvent(ctx, hookEvent.result);
                break;

            case 'refund.successful':
                await this.handleRefundEvent(ctx, hookEvent.result);
                break;

            // TODO: Handle all other event types here!
            default:
                handled = false;
        }
        return handled;
    }

    async handleTrackerEvent(ctx: RequestContext, payload: ITracker) {
        // This is called when a tracker is updated, whether it's created or updated
        console.log(`Tracker event: ${payload.status} for shipment ${payload.shipment_id}`);
        const fulfillment = await this.connection.getRepository(ctx, Fulfillment).findOne({
            where: [
                {
                    trackingCode: payload.tracking_code,
                    handlerCode: easyPostFulfillmentHandler.code,
                    customFields: { trackerId: payload.id },
                },
                // if for some reason we don't have a trackerId (legacy), this should find it
                {
                    trackingCode: payload.tracking_code,
                    handlerCode: easyPostFulfillmentHandler.code,
                    customFields: { shipmentId: payload.shipment_id },
                },
            ],
        });
        if (!fulfillment || fulfillment.state === 'Cancelled') {
            return;
        }

        await this.recordHistory(
            ctx,
            fulfillment.id,
            HistoryEntryType.FulfillmentTrackingEvent,
            {
                status: payload.status,
                detail: payload.status_detail,
                eta: payload.est_delivery_date,
            },
            true,
        );

        const deliveredStates: (typeof payload.status)[] = ['delivered', 'available_for_pickup'];
        const shippedStates: (typeof payload.status)[] = ['in_transit', 'out_for_delivery'];
        if (shippedStates.includes(payload.status) && fulfillment.state !== 'Shipped') {
            await this.fulfillmentService.transitionToState(ctx, fulfillment.id, 'Shipped');
        } else if (deliveredStates.includes(payload.status) && fulfillment.state !== 'Delivered') {
            await this.fulfillmentService.transitionToState(ctx, fulfillment.id, 'Delivered');
        }
    }

    async checkOrderStateFromFulfillments(ctx: RequestContext, order: Order): Promise<boolean> {
        if (!ActivePlacedOrderStates.includes(order.state)) {
            return false;
        }
        const nextOrderStates = this.orderService.getNextOrderStates(order);

        const transitionOrderIfStateAvailable = async (state: OrderState) => {
            if (nextOrderStates.includes(state)) {
                const result = await this.orderService.transitionToState(ctx, order.id, state);
                if (isGraphQlErrorResult(result)) {
                    throw new InternalServerError(result.message);
                }
                return true;
            }
            return false;
        };

        await this.hydrator.hydrate(ctx, order, {
            relations: ['lines', 'fulfillments', 'fulfillments.lines'],
        });

        // Determine what state the order should be in based on fulfillments
        const allFulfilled = this.areAllItemsFulfilled(order);
        const anyFulfilled = this.hasAnyFulfilledItems(order);
        let targetState: OrderState | undefined;

        if (allFulfilled) {
            targetState = 'Shipped';
        } else if (anyFulfilled) {
            targetState = 'PartiallyShipped';
        } else if (order.state !== 'OnHold') {
            // Only transition back to PaymentSettled if the order isn't OnHold
            targetState = 'PaymentSettled';
        }

        // Handle Delivered state
        const orderFulfillments = order.fulfillments?.filter(f => ActiveFulfillmentStates.includes(f.state));
        const allDelivered = orderFulfillments?.every(f => f.state === 'Delivered') ?? false;
        if (allDelivered && allFulfilled) {
            return await transitionOrderIfStateAvailable('Delivered');
        }
        // If it isn't delivered then transition to the target state
        if (targetState && targetState !== order.state) {
            return await transitionOrderIfStateAvailable(targetState);
        }
        return false;
    }

    /**
     * Helper function to get the total fulfilled quantity for an order line by checking
     * all fulfillments associated with the order
     */
    getLineFulfilledQuantity(
        orderLine: OrderLine,
        order: Order,
        validStates: string[] = ActiveFulfillmentStates,
    ): number {
        let fulfilledQuantity = 0;
        for (const fulfillment of order.fulfillments || []) {
            if (!validStates.includes(fulfillment.state)) {
                continue;
            }
            const fulfillmentLine = fulfillment.lines.find(l => l.orderLineId === orderLine.id);
            if (fulfillmentLine) {
                fulfilledQuantity += fulfillmentLine.quantity;
            }
        }
        return fulfilledQuantity;
    }

    /**
     * Checks if an order has any items that are fulfilled (belong to a fulfillment
     * in Purchased state or later)
     */
    hasAnyFulfilledItems(order: Order): boolean {
        for (const line of order.lines) {
            const fulfilledQuantity = this.getLineFulfilledQuantity(line, order);
            if (fulfilledQuantity > 0) {
                return true;
            }
        }
        return false;
    }

    /**
     * Checks if all items in the order are fulfilled
     */
    areAllItemsFulfilled(order: Order): boolean {
        for (const line of order.lines) {
            const fulfilledQuantity = this.getLineFulfilledQuantity(line, order);
            if (fulfilledQuantity < line.quantity) {
                return false;
            }
        }
        return true;
    }
}

/**
 * USPS general format: (ApplicationIdentifier)[Zip5Or+4](TrackingApplicationIdentifier)[ServiceTypeCode][6or9DigitMailerId]Serial#
 * e.g. (420)35570(94)05536208271274677948, (420)80108(94)00136208271275669505, (420)99208(92)61290328749525044112
 *   - AI for USPS domestic shipments is 420; international shipments use a different format altogether
 *   - STC is 3 digits, indicates the service level
 *   - the Mailer ID is consistent for the customer; EasyPost's seems to be 362082712 (903287495 seems to be FedEx's)
 *   - Tracking AI is usually 94, and SHOULD always be part of the "tracking number..." but it isn't
 *     • usually when it's 94 it is, and those are when we buy directly
 *     • we get 92 a lot when it's a FedEx Smart Post shipment, and then the 92 is usually not included in the tracking number...
 *       even though it's visible on the sheet and Publication 199 says it should be part of the tracking number..
 *     • EasyPost likes to give us the USPS tracking number when doing a FedEx Smart Post shipment (which hands off to USPS for
 *       the last mile), but it leaves off the Tracking AI...
 *   - Some barcode readers wrap things like 420 as (420), others don't
 *
 * Because of the inconsistency of how USPS tracking numbers are reported, we need to look for fulfillments using both
 * variants, with and without the Tracking AI. For efficiency, since we know 94 is usually part of the tracking code, we'll
 * look first with the TAI if it is 94, then without; but if the TAI is not 94, we will look first WITHOUT the TAI, then with.
 */
const rUspsBarcodeFormat = /^\(?420\)?[\d-]{5,10}\(?(9[1-5])\)?(\d+)$/;

/**
 * FedEx uses a couple different formats.
 *   - FDX1D: [8digitProductIndex][12digitApplicationData][14digitTrackingNumber]
 *     • even in this case, the tracking number given to customers is usually only 12 digits... 00[12digits]
 *     • all characters are digits, there are no parentheses
 *   - FedEx Ground 96: these start with 96 (encoded as `(96)` in the barcode) followed by 20 or 22 digits,
 *     of which we still only care about the last 12
 *
 * Strategy: look for both kinds, and rip off any leading zeroes if the code is longer than 12 digits
 */
const rFedExBarcodeFormat = /^(?:[\d]{20}([\d]{14})$|^\(?96\)?\d+([\d]{12}))$/;

/** Sometimes we need to look up a few different variants of the tracking code, so return an array in priority order. */
function trackingNumbersForBarcode(barcode: string): string[] {
    // special USPS handling
    const uspsMatch = barcode.match(rUspsBarcodeFormat);
    if (uspsMatch) {
        const [, tai, code] = uspsMatch;
        if (tai === '94') {
            return [`${tai}${code}`, code];
        } else {
            return [code, `${tai}${code}`];
        }
    }
    const fedExMatch = barcode.match(rFedExBarcodeFormat);
    if (fedExMatch) {
        const [, fdx1d, fedEx96] = fedExMatch;
        if (fedEx96) return [fedEx96];
        return [fdx1d.replace(/^0+/, '')];
    }
    return [barcode];
}
