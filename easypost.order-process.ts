import { HistoryEntryType } from '@vendure/common/lib/generated-types';
import {
    EntityHydrator,
    HistoryService,
    Order,
    OrderProcess,
    OrderState,
    RequestContext,
} from '@vendure/core';
import { EasyPostFulfillmentService } from './services/fulfillment-service';

/**
 * Ensures the order has the required relations loaded
 */
async function hydrateOrder(
    ctx: RequestContext,
    order: Order,
    entityHydrator: EntityHydrator,
): Promise<Order> {
    await entityHydrator.hydrate(ctx, order, {
        relations: ['lines', 'fulfillments', 'fulfillments.lines'],
    });
    return order;
}

let entityHydrator: EntityHydrator;
let historyService: HistoryService;
let easyPostFulfillmentService: EasyPostFulfillmentService;

declare module '@vendure/core' {
    interface OrderStates {
        OnHold: 'OnHold';
    }
}

export const easyPostOrderProcess: OrderProcess<OrderState> = {
    transitions: {
        Created: {
            to: [],
            mergeStrategy: 'merge',
        },
        Draft: {
            to: [],
            mergeStrategy: 'merge',
        },
        AddingItems: {
            to: [],
            mergeStrategy: 'merge',
        },
        ArrangingPayment: {
            to: [],
            mergeStrategy: 'merge',
        },
        PaymentAuthorized: {
            to: [],
            mergeStrategy: 'merge',
        },
        PaymentSettled: {
            to: [
                'Delivered',
                'PartiallyShipped',
                'Shipped',
                'OnHold',
                'Cancelled',
                'Modifying',
                'ArrangingAdditionalPayment',
            ],
            mergeStrategy: 'replace',
        },
        OnHold: {
            to: [
                'ArrangingAdditionalPayment',
                'PaymentSettled',
                'Modifying',
                'PartiallyShipped',
                'Shipped',
                'Cancelled',
            ],
        },
        PartiallyShipped: {
            to: ['Shipped', 'PaymentSettled', 'Cancelled', 'Modifying'],
            mergeStrategy: 'replace',
        },
        Shipped: {
            to: ['Delivered', 'PartiallyShipped', 'PaymentSettled', 'Cancelled', 'Modifying'],
            mergeStrategy: 'replace',
        },
        Delivered: {
            to: ['Cancelled'],
            mergeStrategy: 'replace',
        },
        Modifying: {
            to: [
                'PaymentAuthorized',
                'PaymentSettled',
                'OnHold',
                'PartiallyShipped',
                'Shipped',
                'ArrangingAdditionalPayment',
            ],
            mergeStrategy: 'replace',
        },
        ArrangingAdditionalPayment: {
            to: [
                'PaymentAuthorized',
                'PaymentSettled',
                'PartiallyShipped',
                'Shipped',
                'Cancelled',
                'Modifying',
            ],
            mergeStrategy: 'merge',
        },
        Cancelled: {
            to: [],
            mergeStrategy: 'merge',
        },
        PartiallyDelivered: {
            // Shouldn't ever get into this state, but in case it somehow happens...
            to: ['PartiallyShipped', 'Shipped'],
            mergeStrategy: 'replace',
        },
    },

    async init(injector) {
        entityHydrator = injector.get(EntityHydrator);
        historyService = injector.get(HistoryService);
        easyPostFulfillmentService = injector.get(EasyPostFulfillmentService);
    },

    async onTransitionStart(fromState, toState, data) {
        const { ctx, order } = data;
        await hydrateOrder(ctx, order, entityHydrator);

        if (toState === 'Shipped') {
            if (!easyPostFulfillmentService.areAllItemsFulfilled(order)) {
                return `Cannot transition to Shipped because not all items have been fulfilled`;
            }
        }

        if (toState === 'PartiallyShipped') {
            const anyFulfilled = easyPostFulfillmentService.hasAnyFulfilledItems(order);
            const allFulfilled = easyPostFulfillmentService.areAllItemsFulfilled(order);
            if (!anyFulfilled) {
                return `Cannot transition to PartiallyShipped because no items have been fulfilled`;
            }
            if (allFulfilled) {
                return `Cannot transition to PartiallyShipped because all items are fulfilled`;
            }
        }

        if (fromState === 'PaymentSettled') {
            // When leaving PaymentSettled, we need to verify the fulfilled state
            if (toState === 'Shipped' && !easyPostFulfillmentService.areAllItemsFulfilled(order)) {
                return `Cannot transition to Shipped because not all items have been fulfilled`;
            }
            if (toState === 'PartiallyShipped' && !easyPostFulfillmentService.hasAnyFulfilledItems(order)) {
                return `Cannot transition to PartiallyShipped because no items have been fulfilled`;
            }
        }
    },

    async onTransitionEnd(fromState, toState, data) {
        const { ctx, order } = data;
        await historyService.createHistoryEntryForOrder({
            orderId: order.id,
            type: HistoryEntryType.ORDER_STATE_TRANSITION,
            ctx,
            data: {
                from: fromState,
                to: toState,
            },
        });
    },
};
