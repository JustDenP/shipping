import {
    CustomFieldConfig,
    CustomFulfillmentFields,
    EntityHydrator,
    FulfillmentHandler,
    Injector,
    LanguageCode,
} from '@vendure/core';
import { EasyPostFulfillmentService } from './services/fulfillment-service';
import { getFulfillmentOrderLines, improvedCalculateShipDimensions } from './services/utils';

let epFulfillmentService: EasyPostFulfillmentService;
let hydrator: EntityHydrator;

const nonPendingStates = ['Created', 'OnHold'];

export const easyPostFulfillmentHandler = new FulfillmentHandler({
    code: 'easy-post',
    description: [{ languageCode: LanguageCode.en, value: 'EasyPost Fulfillment Handler' }],
    args: {
        treatAsManual: {
            type: 'boolean',
            label: [{ languageCode: LanguageCode.en, value: 'Treat as Manual Fulfillment' }],
            description: [
                { languageCode: LanguageCode.en, value: 'Whether to treat this fulfillment as manual' },
            ],
            required: false,
            defaultValue: false,
        },
        trackingCode: {
            type: 'string',
            label: [{ languageCode: LanguageCode.en, value: 'Tracking Code' }],
            description: [
                {
                    languageCode: LanguageCode.en,
                    value: `If provided, we'll attempt to set up an EasyPost Tracker for shipping updates`,
                },
            ],
            defaultValue: '',
            required: false,
        },
    },
    init: (injector: Injector) => {
        epFulfillmentService = injector.get(EasyPostFulfillmentService);
        hydrator = injector.get(EntityHydrator);
    },

    createFulfillment: async (ctx, orders, lines, args) => {
        // make sure lines are hydrated
        await Promise.all(
            orders.map(order =>
                hydrator.hydrate(ctx, order, {
                    relations: ['lines', 'lines.productVariant', 'fulfillments'],
                }),
            ),
        );
        const orderWithServiceInfo = orders.find(o => o.customFields?.serviceName);
        const fulfillmentLines = getFulfillmentOrderLines(orders, lines);
        const orderCodes = orders.map(o => o.code).join(',');
        let priorFulfillmentCount = 0;
        for (const fulfillment of orders.flatMap(o => o.fulfillments)) {
            // only increment the invoice ID for active fulfillments OR cancelled fulfillments that we bought a label for
            if (fulfillment.state !== 'Cancelled' || fulfillment.customFields.ratePurchasedAt) {
                priorFulfillmentCount++;
            }
        }
        const invoiceId = orderCodes + (priorFulfillmentCount ? `-${priorFulfillmentCount}` : '');
        const method = args.treatAsManual
            ? 'Manual Fulfillment'
            : orderWithServiceInfo?.customFields?.serviceName || '';
        const calculatedDimensions = improvedCalculateShipDimensions(fulfillmentLines);
        const customFields: CustomFulfillmentFields = {
            invoiceId,
            treatAsManual: args.treatAsManual,
            // Package dimensions are calculated from the lines we're actually shipping -- it could be
            // multiple orders, or part of a single order, so trusting what's saved on a single order
            // isn't reliable enough. If they need to be overridden because we needed to ship a different
            // size, they must be updated manually before purchasing the label.
            weight: calculatedDimensions.weightInOunces,
            height: calculatedDimensions.heightInInches,
            width: calculatedDimensions.widthInInches,
            length: calculatedDimensions.lengthInInches,
        };
        if (!args.treatAsManual && orderWithServiceInfo) {
            // if this is meant to be fulfilled and shipped normally, record what the user selected for
            // shipping on the first order; this is what we'll use to purchase from EasyPost
            customFields.carrierId = orderWithServiceInfo.customFields?.carrierId;
            customFields.carrierCode = orderWithServiceInfo.customFields?.carrierCode;
            customFields.serviceCode = orderWithServiceInfo.customFields?.serviceCode;
            customFields.serviceName = orderWithServiceInfo.customFields?.serviceName;
        }

        return {
            method,
            customFields,
            // we'll store the e.g. USPS tracking code here once we've bought the label, so only
            // add one now if it was provided as part of a manual fulfillment
            trackingCode: args.treatAsManual ? args.trackingCode : '',
        };
    },

    onFulfillmentTransition: async (fromState, toState, { ctx, fulfillment }) => {
        try {
            if (
                toState === 'Pending' &&
                nonPendingStates.includes(fromState) &&
                !fulfillment.customFields.treatAsManual
            ) {
                // Recreate as needed as long as we're coming from Created or OnHold
                await epFulfillmentService.createShipment(ctx, fulfillment);
            } else if (toState === 'Purchased') {
                if (!fulfillment.customFields.treatAsManual) {
                    // will throw and error and prevent transition if we haven't locked in a rate
                    await epFulfillmentService.purchaseShipment(ctx, fulfillment);
                } else if (fulfillment.trackingCode) {
                    // usually silently ignores bad states, but throws an error if there's a problem creating the tracker
                    await epFulfillmentService.purchaseTracker(ctx, fulfillment);
                }
            } else if (toState === 'Cancelled' && ['Purchased', 'Tendered'].includes(fromState)) {
                if (fulfillment.customFields.shipmentId && fulfillment.customFields.ratePurchasedAt) {
                    // We have purchased the rate, so we need to refund it
                    await epFulfillmentService.refundShipment(ctx, fulfillment.id);
                }
            }
        } catch (e: any) {
            console.error(e);
            return `Error transitioning fulfillment: ${e?.message || e}`;
        }
    },
});

export type ExtractTypeMap<T extends readonly CustomFieldConfig[]> = {
    [K in T[number] as K['name']]?: Pick<K, 'type' | 'label'>;
};
