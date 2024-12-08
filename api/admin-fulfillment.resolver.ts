import { In } from 'typeorm';
import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import {
    Ctx,
    RequestContext,
    Allow,
    Permission,
    ListQueryBuilder,
    ID,
    Fulfillment,
    PaginatedList,
    TransactionalConnection,
    Transaction,
    FulfillmentService,
    Order,
    ApiType,
    Api,
    HistoryService,
    Relations,
    RelationPaths,
    OrderService,
    FulfillmentState,
    isGraphQlErrorResult,
    CustomOrderFields,
} from '@vendure/core';
import { EasyPostFulfillmentService } from '../services/fulfillment-service';
import {
    FulfillmentHistoryArgs,
    HistoryEntryListOptions,
    MutationTransitionFulfillmentToStateWithCustomFieldsArgs,
    OrderLineInput,
    OrderStateCheckResult,
    QueryShippableOrdersArgs,
    SortOrder,
    UpdateFulfillmentShippingDetailsInput,
} from '../../codegen/generated-admin-types';
import { easyPostFulfillmentHandler } from '../fulfillment-handler';
import { compareStrings } from '../../../../src/lib/string';

const fulfillmentActive = ['Created', 'Pending', 'OnHold'];
@Resolver('Fulfillment')
export class EasyPostAdminFulfillmentResolver {
    constructor(
        private connection: TransactionalConnection,
        private easyPostService: EasyPostFulfillmentService,
        private fulfillmentService: FulfillmentService,
        private listQueryBuilder: ListQueryBuilder,
        private historyService: HistoryService,
        private orderService: OrderService,
    ) {}

    // Query: Get shipping rates for an order
    // @Query()
    // @Allow(Permission.ReadShippingMethod, Permission.ReadOrder)
    // async orderShippingRates(@Ctx() ctx: RequestContext, @Args() args: QueryOrderShippingRatesArgs) {
    //     const order = await this.orderService.findOne(ctx, args.orderID, [
    //         'lines',
    //         'lines.productVariant',
    //         'lines.taxCategory',
    //     ]);

    //     // Validate if the order exists
    //     if (!order) {
    //         throw new UserInputError('No order with given id found');
    //     }

    //     // Validate if the shipping address has sufficient details
    //     if (!order.shippingAddress?.postalCode || !order.shippingAddress?.city) {
    //         throw new UserInputError('Please provide proper postal code and shipping city');
    //     }
    //     if (order.state == 'Delivered') {
    //         throw new UserInputError('The order is already delivered');
    //     }
    //     const variants = order.lines.map((line: { productVariant: any }) => line?.productVariant);
    //     if (variants.length == 0) {
    //         throw new UserInputError('No/Error items found in the order');
    //     }

    //     // TODO: This isn't returning the right thing
    //     return this.easyPostService.getRawShippingRates(ctx, order);
    // }

    @ResolveField()
    async history(
        @Ctx() ctx: RequestContext,
        @Api() apiType: ApiType,
        @Parent() fulfillment: Fulfillment,
        @Args() args: FulfillmentHistoryArgs,
    ) {
        const publicOnly = apiType === 'shop';
        const options: HistoryEntryListOptions = { ...args.options };
        if (!options.sort) {
            options.sort = { createdAt: SortOrder.ASC };
        }
        return this.historyService.getHistoryForFulfillment(ctx, fulfillment.id, publicOnly, options);
    }

    @Transaction()
    @Mutation()
    @Allow(Permission.UpdateOrder)
    async transitionFulfillmentToStateWithCustomFields(
        @Ctx() ctx: RequestContext,
        @Args() args: MutationTransitionFulfillmentToStateWithCustomFieldsArgs,
    ) {
        const { input, state } = args;
        const response = await this.orderService.transitionFulfillmentToState(
            ctx,
            input.id,
            state as FulfillmentState,
        );

        if (isGraphQlErrorResult(response)) {
            return response;
        } else {
            await this.connection.getRepository(ctx, Fulfillment).update(input.id, {
                customFields: {
                    ...input.customFields,
                },
            });
        }
        return response;
    }

    @Transaction()
    @Mutation()
    @Allow(Permission.UpdateOrder)
    async correctOrderStates(
        @Ctx() ctx: RequestContext,
        @Args('orderIds') orderIds: ID[],
    ): Promise<OrderStateCheckResult[]> {
        const promiseResults = await Promise.allSettled(
            orderIds.map(async orderId => {
                const order = await this.connection.getEntityOrThrow(ctx, Order, orderId);
                const didChange = await this.easyPostService.checkOrderStateFromFulfillments(ctx, order);
                return { orderId, state: order.state, changed: didChange };
            }),
        );
        const results: OrderStateCheckResult[] = [];
        for (const r of promiseResults) {
            if (r.status === 'fulfilled') {
                results.push({
                    orderId: r.value.orderId,
                    changed: r.value.changed,
                    __typename: 'OrderStateCheckResult',
                });
            } else {
                results.push({
                    orderId: r.reason?.message ?? (r.reason || 'Unknown error'),
                    changed: false,
                    __typename: 'OrderStateCheckResult',
                });
            }
        }

        return results;
    }

    @Query()
    @Allow(Permission.ReadOrder)
    shippableOrders(
        @Ctx() ctx: RequestContext,
        @Args() args: QueryShippableOrdersArgs,
        @Relations(Order) relations: RelationPaths<Order>,
    ): Promise<PaginatedList<Order>> {
        return this.listQueryBuilder
            .build(Order, args.options, {
                ctx,
                relations: relations ?? [
                    'lines',
                    'customer',
                    'lines.productVariant',
                    'channels',
                    'shippingLines',
                    'payments',
                ],
                where: {
                    state: In(['OnHold', 'PaymentSettled', 'PartiallyShipped', 'PartiallyDelivered']),
                },
                channelId: ctx.channelId,
                customPropertyMap: {
                    customerEmail: 'customer.emailAddress',
                    customerLastName: 'customer.lastName',
                    transactionId: 'payments.transactionId',
                },
            })
            .getManyAndCount()
            .then(([items, totalItems]) => {
                return {
                    items,
                    totalItems,
                };
            });
    }

    @Query()
    @Allow(Permission.ReadOrder)
    async fulfillments(@Ctx() ctx: RequestContext, @Args() args: any): Promise<PaginatedList<Fulfillment>> {
        return this.listQueryBuilder
            .build(Fulfillment, args.options, {
                ctx,
                relations: ['orders', 'orders.customer', 'lines.orderLine', 'easypostPickup'],
                customPropertyMap: {
                    orderCode: 'orders.code',
                    customerLastName: 'orders.customer.lastName',
                    customerEmail: 'orders.customer.emailAddress',
                    productVariantSku: 'lines.orderLine.productVariant.sku',
                    pickupState: 'easypostPickup.state',
                },
            })
            .getManyAndCount()
            .then(([items, totalItems]) => ({
                items,
                totalItems,
            }));
    }

    @Query()
    @Allow(Permission.ReadOrder)
    async fulfillment(@Ctx() ctx: RequestContext, @Args('id') id: ID): Promise<Fulfillment | undefined> {
        const fulfillment = await this.connection.getRepository(ctx, Fulfillment).findOne({
            where: { id },
            relations: ['orders', 'orders.lines', 'orders.customer', 'lines.orderLine', 'easypostPickup'],
        });
        return fulfillment;
    }

    @Query()
    @Allow(Permission.UpdateOrder)
    async fulfillmentAvailableShippingRates(@Ctx() ctx: RequestContext, @Args('id') id: ID) {
        return await this.easyPostService.getShippingRatesForFulfillment(ctx, id);
    }

    @Query()
    @Allow(Permission.UpdateOrder)
    async unfulfilledOrderRates(@Ctx() ctx: RequestContext, @Args('orderId') orderId: ID) {
        const order = await this.connection.getEntityOrThrow(ctx, Order, orderId);
        return this.easyPostService.getRatesForUnfulfilledOrder(ctx, order);
    }

    @Mutation()
    @Transaction()
    @Allow(Permission.UpdateOrder)
    async updateFulfillmentShippingDetails(
        @Ctx() ctx: RequestContext,
        @Args('id') id: ID,
        @Args('input') input: UpdateFulfillmentShippingDetailsInput,
    ): Promise<Fulfillment> {
        const curFulfillment = await this.connection.getEntityOrThrow(ctx, Fulfillment, id);
        await this.easyPostService.updateShippingDetails(ctx, curFulfillment, input);
        return this.fulfillment(ctx, id);
    }

    @Mutation()
    @Allow(Permission.UpdateSystem)
    async clearEasypostCache(@Ctx() ctx: RequestContext): Promise<boolean> {
        await this.easyPostService.clearCache(ctx);
        return true;
    }

    @Mutation()
    @Transaction()
    @Allow(Permission.UpdateOrder)
    async combineFulfillments(
        @Ctx() ctx: RequestContext,
        @Args('fulfillmentIds') fulfillmentIds: ID[],
    ): Promise<Fulfillment> {
        if (!fulfillmentIds || fulfillmentIds.length < 2) {
            throw new Error('At least 2 fulfillment ids are required to combine them');
        }
        // this.connection.getRepository(ctx, Fulfillment).findByIds
        const fulfillments = await this.connection.getRepository(ctx, Fulfillment).find({
            where: { id: In(fulfillmentIds) },
            relations: ['orders', 'orders.lines', 'lines.orderLine'],
        });
        if (!fulfillments || fulfillments.length < 2) {
            throw new Error('At least 2 fulfillments are required to combine them');
        }
        if (!fulfillments.every(f => f.state === 'Created')) {
            throw new Error('Only fulfillments in the "Created" state can be combined');
        }
        const orders = fulfillments.flatMap(f => f.orders);
        throwIfCustomerIdOrShippingAddressDiffer(orders);

        const lines: OrderLineInput[] = fulfillments
            .flatMap(f => f.lines.map(l => ({ orderLineId: l.orderLineId, quantity: l.quantity })))
            .filter(l => l.quantity > 0);

        await Promise.all(
            fulfillments.map(f => this.fulfillmentService.transitionToState(ctx, f.id, 'Cancelled')),
        );
        const fulfillment = await this.fulfillmentService.create(ctx, orders, lines, {
            code: easyPostFulfillmentHandler.code,
            arguments: [],
        });
        if (!(fulfillment as Fulfillment).id) {
            throw fulfillment;
        } else {
            await Promise.all(
                orders.map(o => {
                    o.fulfillments.push(fulfillment as Fulfillment);
                    return this.connection.getRepository(ctx, Order).save(o);
                }),
            );

            return this.fulfillment(ctx, (fulfillment as Fulfillment).id);
        }
    }

    @Mutation()
    @Transaction()
    @Allow(Permission.UpdateOrder)
    async ensurePendingFulfillment(
        @Ctx() ctx: RequestContext,
        @Args('orderIds') orderIds: ID[],
    ): Promise<Fulfillment> {
        if (!orderIds?.length) {
            throw new Error('No order id provided');
        }
        // Get the order with all the relations we need
        const orders = await Promise.all(
            orderIds.map(orderId =>
                this.connection.getEntityOrThrow(ctx, Order, orderId, {
                    relations: ['lines', 'fulfillments', 'fulfillments.lines', 'fulfillments.orders'],
                }),
            ),
        );
        if (orders.length !== orderIds.length) {
            throw new Error(`Invalid order id provided`);
        }
        throwIfCustomerIdOrShippingAddressDiffer(orders);

        // Look for an existing active fulfillment that covers all orderIds
        const existingFulfillment = orders[0].fulfillments?.find(
            f =>
                ['Created', 'Pending'].includes(f.state) &&
                f.orders.length === orders.length &&
                f.orders.every(o => orderIds.includes(o.id)),
        );

        if (existingFulfillment) {
            if (existingFulfillment.state === 'Pending') {
                return existingFulfillment;
            }
            const result = await this.fulfillmentService.transitionToState(
                ctx,
                existingFulfillment.id,
                'Pending',
            );
            if (isGraphQlErrorResult(result)) {
                throw result;
            }
            return result.fulfillment;
        }

        // If you're combining order shipments, we're going to assume you want to send it all,
        // so cancel any Created / Pending / OnHold fulfillments for any of these orders and
        // create a new one that encompasses all of it
        const fulfillmentsToCancel = orders
            .flatMap(o => o.fulfillments)
            .filter(f => fulfillmentActive.includes(f.state));
        await Promise.all(
            fulfillmentsToCancel.map(f =>
                this.fulfillmentService
                    .transitionToState(ctx, f.id, 'Cancelled')
                    .then(() => (f.state = 'Cancelled')),
            ),
        );

        // Calculate remaining unfulfilled quantities for each order line
        const unfulfilledLines: OrderLineInput[] = [];
        for (const order of orders) {
            unfulfilledLines.push(
                ...order.lines
                    .map(line => {
                        const fulfilledQuantity = order.fulfillments
                            .filter(f => !['Cancelled'].includes(f.state))
                            .flatMap(f => f.lines)
                            .filter(fl => fl.orderLineId === line.id)
                            .reduce((sum, fl) => sum + fl.quantity, 0);
                        return {
                            orderLineId: line.id,
                            quantity: line.quantity - fulfilledQuantity,
                        };
                    })
                    .filter(line => line.quantity > 0),
            );
        }

        if (unfulfilledLines.length === 0) {
            throw new Error(`No unfulfilled items for order ${orders.map(o => o.code).join(', ')}`);
        }

        // Create the fulfillment and prep it for shipping by going to Pending
        const result = await this.orderService.createFulfillment(ctx, {
            lines: unfulfilledLines,
            handler: {
                code: easyPostFulfillmentHandler.code,
                arguments: [],
            },
        });

        if (isGraphQlErrorResult(result)) {
            throw result;
        }

        // If the fulfillment has different shipping metadata than any of the orders, update them to match
        for (const order of orders) {
            for (const field of ['carrierCode', 'carrierId', 'serviceCode', 'serviceName']) {
                let changed = false;
                const customFields: Partial<CustomOrderFields> = {};
                if (order.customFields[field] !== result.customFields[field]) {
                    customFields[field] = result.customFields[field];
                    changed = true;
                }
                if (changed) {
                    await this.orderService.updateCustomFields(ctx, order.id, customFields);
                }
            }
        }

        return result;
    }

    @Mutation()
    @Transaction()
    @Allow(Permission.UpdateOrder)
    async shippingLabelScanned(
        @Ctx() ctx: RequestContext,
        @Args('barcode') barcode: string,
    ): Promise<Fulfillment> {
        return this.easyPostService.shippingLabelScanned(ctx, barcode);
    }

    @Mutation()
    @Transaction()
    @Allow(Permission.UpdateOrder)
    async undoShippingLabelScan(
        @Ctx() ctx: RequestContext,
        @Args('fulfillmentId') fulfillmentId: ID,
    ): Promise<Fulfillment> {
        return this.easyPostService.undoShippingLabelScan(ctx, fulfillmentId);
    }
}

function throwIfCustomerIdOrShippingAddressDiffer(orders: Order[]) {
    const customerIds = new Set(orders.map(o => o.customerId));
    if (customerIds.size > 1) {
        throw new Error('Orders must belong to the same customer to be combined');
    }
    const addresses = orders.map(o => o.shippingAddress);
    const addr1 = addresses[0];
    for (const addr of addresses) {
        if (
            !compareStrings(addr.streetLine1, addr1.streetLine1) ||
            !compareStrings(addr.streetLine2, addr1.streetLine2) ||
            !compareStrings(addr.city, addr1.city) ||
            !compareStrings(addr.province, addr1.province) ||
            !compareStrings(addr.postalCode, addr1.postalCode) ||
            !compareStrings(addr.countryCode, addr1.countryCode)
        ) {
            throw new Error('All orders must have the same shipping address to be combined');
        }
    }
}
