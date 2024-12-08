import {
    awaitPromiseOrObservable,
    ConfigService,
    EntityHydrator,
    FulfillmentLine,
    FulfillmentProcess,
    FulfillmentStates,
    HistoryService,
    StockLevelService,
    StockMovementService,
    TransactionalConnection,
} from '@vendure/core';
import { HistoryEntryType } from '../codegen/generated-admin-types';
import { EasyPostFulfillmentService, nonPendingFulfillmentStates } from './services/fulfillment-service';

let configService: ConfigService;
let connection: TransactionalConnection;
let entityHydrator: EntityHydrator;
let historyService: HistoryService;
let easyPostFulfillmentService: EasyPostFulfillmentService;
let stockLevelService: StockLevelService;
let stockMovementService: StockMovementService;

async function checkStockLevels(ctx, line: FulfillmentLine): Promise<string | void> {
    const variant = line.orderLine.productVariant;
    const quantity = line.quantity;
    const { stockOnHand, stockAllocated } = await stockLevelService.getAvailableStock(ctx, variant.id);
    // If there is not enough stock on hand to fulfill the order, return an error message
    if (quantity > stockOnHand) {
        return `Not enough stock of ${variant.sku}! Only ${stockOnHand} on hand (${stockAllocated} total allocated).`;
    }
}

declare module '@vendure/core' {
    interface FulfillmentStates {
        OnHold: 'OnHold';
        Purchased: 'Purchased';
        Tendered: 'Tendered';
    }
}

export const easyPostFulfillmentProcess: FulfillmentProcess<keyof FulfillmentStates> = {
    // normal process is "Created" -> "Pending" -> "Purchased" -> "Tendered" -> "Shipped" -> "Delivered"
    transitions: {
        /** Created is automatic when the order reaches PaymentSettled. */
        Created: {
            to: ['Pending', 'Purchased', 'OnHold', 'Cancelled'],
            mergeStrategy: 'replace',
        },
        /**
         * Pending creates the shipment in EasyPost and gets final rate costs;
         * final review before purchasing the label.
         */
        Pending: {
            to: ['Purchased', 'Created', 'OnHold', 'Cancelled'],
            mergeStrategy: 'replace',
        },
        /** OnHold is for things like "oops, we don't actually have enough stock yet" or similar */
        OnHold: {
            to: ['Pending', 'Created', 'Cancelled'],
            mergeStrategy: 'replace',
        },
        /** Purchased means we have purchased the shipping label from EasyPost. */
        Purchased: {
            to: ['Tendered', 'Shipped', 'Delivered', 'Cancelled'],
            mergeStrategy: 'replace',
        },
        /**
         * Tendered means we've packaged the order and given it to the carrier, but
         * they might not have processed it yet. We can go from Tendered -> Purchased
         * e.g. if we discover we lost or never really packaged the order.
         */
        Tendered: {
            to: ['Shipped', 'Delivered', 'Purchased', 'Cancelled'],
            mergeStrategy: 'replace',
        },
        Shipped: {
            to: ['Delivered'],
            mergeStrategy: 'replace',
        },
        Delivered: {
            to: [],
            mergeStrategy: 'replace',
        },
        Cancelled: {
            to: [],
            mergeStrategy: 'replace',
        },
    },

    async init(injector) {
        configService = injector.get(ConfigService);
        connection = injector.get(TransactionalConnection);
        entityHydrator = injector.get(EntityHydrator);
        historyService = injector.get(HistoryService);
        easyPostFulfillmentService = injector.get(EasyPostFulfillmentService);
        stockLevelService = injector.get(StockLevelService);
        stockMovementService = injector.get(StockMovementService);
    },

    onTransitionStart: async (fromState, toState, data) => {
        const { ctx, fulfillment } = data;
        if (toState === 'Pending') {
            // Make sure we have all the data we need for any orders
            await entityHydrator.hydrate(ctx, fulfillment, {
                relations: ['lines', 'lines.orderLine', 'lines.orderLine.productVariant'],
            });
            const errors = (
                await Promise.all(fulfillment.lines.map(line => checkStockLevels(ctx, line)))
            ).filter(Boolean);
            if (errors.length) {
                return errors.join('\n');
            }
        }

        // basic checks out of the way, now give fulfillment handlers a chance to do their thing
        const { fulfillmentHandlers } = configService.shippingOptions;
        const fulfillmentHandler = fulfillmentHandlers.find(h => h.code === fulfillment.handlerCode);
        if (fulfillmentHandler) {
            const result = await awaitPromiseOrObservable(
                fulfillmentHandler.onFulfillmentTransition(fromState, toState, data),
            );
            if (result === false || typeof result === 'string') {
                return result;
            }
        }
    },

    async onTransitionEnd(fromState, toState, { ctx, fulfillment, orders }): Promise<void> {
        // Should only allocate stock if coming from Created or OnHold,
        // which should be the only way we get here anyway, but just to be sure...
        if (toState === 'Pending' && nonPendingFulfillmentStates.includes(fromState)) {
            await stockMovementService.createSalesForOrder(ctx, fulfillment.lines);
        } else if (fromState === 'Pending' && nonPendingFulfillmentStates.includes(toState)) {
            const orderLineInput = fulfillment.lines.map(l => ({
                orderLineId: l.orderLineId,
                quantity: l.quantity,
            }));
            await stockMovementService.createCancellationsForOrderLines(ctx, orderLineInput);
            await stockMovementService.createAllocationsForOrderLines(ctx, orderLineInput);

            if (toState !== 'Cancelled') {
                // keep the info for posterity if we're cancelling, otherwise clear for future transitions
                await connection.getRepository(ctx, 'Fulfillment').update(fulfillment.id, {
                    customFields: {
                        shipmentId: null,
                        rateId: null,
                        rateCost: null,
                    },
                });
            }
        }

        // Create history entries for each affected order
        const historyEntryPromises = orders.map(order =>
            historyService.createHistoryEntryForOrder({
                orderId: order.id,
                type: HistoryEntryType.ORDER_FULFILLMENT_TRANSITION as any,
                ctx,
                data: {
                    fulfillmentId: fulfillment.id,
                    from: fromState,
                    to: toState,
                },
            }),
        );

        await Promise.all(historyEntryPromises);

        // Handle order state transitions
        for (const order of orders) {
            await easyPostFulfillmentService.checkOrderStateFromFulfillments(ctx, order);
        }
    },
};
