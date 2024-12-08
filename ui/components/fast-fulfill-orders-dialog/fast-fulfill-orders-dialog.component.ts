import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { DataService, Dialog } from '@vendure/admin-ui/core';
import {
    EnsurePendingFulfillmentDocument,
    GetShippableOrderListQuery,
    TransitionFulfillmentWithCustomFieldsDocument,
} from '../../generated-types';
import { openLabelsInNewWindow, openPickListInNewWindow } from '../../utils';

type ShippableOrder = GetShippableOrderListQuery['shippableOrders']['items'][number];
type ShippableOrderMaybeExtraOrderIds = ShippableOrder & {
    extraOrders?: ShippableOrder[];
};
type OrderStatus = Record<
    string,
    {
        processing?: boolean;
        error?: string;
        shipment: {
            /** Fulfillment id */
            id?: string;
            /** How much we collected from the customer (order.shipping) */
            collected: number;
            /** How much we're spending on the actual label */
            cost?: number;
            /** When did we send the purchase order */
            purchasedAt?: Date;
            /** Is there a commercial invoice available? */
            commInvoiceUrl?: string;
        };
    }
>;

@Component({
    selector: 'ep-fast-fulfill-orders-dialog',
    templateUrl: './fast-fulfill-orders-dialog.component.html',
    styleUrls: ['./fast-fulfill-orders-dialog.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FastFulfillOrdersDialogComponent implements Dialog<boolean>, OnInit {
    resolveWith: (didWork?: boolean) => void;
    step: 'prepare' | 'purchase' | 'print' | 'done' = 'prepare';
    orders: ShippableOrder[] = [];
    displayOrders: ShippableOrderMaybeExtraOrderIds[] = [];
    orderStatus: OrderStatus;
    progressBar?: ProgressBar;
    totalCost = 0;

    constructor(private cd: ChangeDetectorRef, private dataService: DataService) {}

    close() {
        this.resolveWith(!!(this.progressBar || this.step !== 'prepare'));
    }

    ngOnInit(): void {
        const seenFulfillments: Record<string, ShippableOrderMaybeExtraOrderIds> = {};
        for (let order of this.orders) {
            order = structuredClone(order);
            const f = getActiveFulfillment(order);
            if (f && seenFulfillments[f.id]) {
                seenFulfillments[f.id].extraOrders = seenFulfillments[f.id].extraOrders || [];
                seenFulfillments[f.id].extraOrders!.push(order);
                continue;
            }
            if (f) seenFulfillments[f.id] = order;
            this.displayOrders.push(order);
        }

        this.orderStatus = Object.fromEntries(
            this.displayOrders.map(order => [
                order.code,
                {
                    shipment: {
                        collected: [order, ...(order.extraOrders || [])].reduce(
                            (acc, o) => acc + o.shipping,
                            0,
                        ),
                    },
                } satisfies OrderStatus[''],
            ]),
        );
    }

    costAnalysis(order: ShippableOrderMaybeExtraOrderIds) {
        const s = this.orderStatus[order.code].shipment;
        if (!s.id) {
            return null;
        }
        const cost = s.cost || 0;
        const difference = cost - s.collected;
        return {
            collected: s.collected,
            cost,
            difference,
            freeShipping: isFreeShipping(order),
        };
    }

    async prepareShipments() {
        this.progressBar = new ProgressBar(this.displayOrders.length);
        this.progressBar.message = 'Preparing shipments...';
        this.totalCost = 0;
        for (const order of this.displayOrders) {
            const s = this.orderStatus[order.code];
            s.processing = true;
            this.cd.markForCheck();
            try {
                // Prepare shipment
                const result = await this.dataService
                    .mutate(EnsurePendingFulfillmentDocument, {
                        orderIds: [order.id, ...(order.extraOrders?.map(o => o.id) || [])],
                    })
                    .pipe()
                    .toPromise();
                if (!result?.ensurePendingFulfillment) {
                    throw result;
                }
                const fulfillment = result.ensurePendingFulfillment;
                s.shipment.id = fulfillment.id;
                s.shipment.cost =
                    (fulfillment.customFields?.rateCost || 0) +
                    (fulfillment.customFields?.insuranceCost || 0);
                this.totalCost += s.shipment.cost || 0;
                this.progressBar.success++;
            } catch (e: any) {
                s.error = e?.message || e;
                this.progressBar.error++;
            } finally {
                s.processing = false;
                this.cd.markForCheck();
            }
        }
        this.resortOrdersByStatus();
        this.progressBar.message = `Ready to purchase ${this.progressBar.success} shipment(s)`;
        this.step = this.progressBar.success ? 'purchase' : 'done';
    }

    async purchaseShipments() {
        const readyOrders = this.displayOrders.filter(
            order =>
                this.orderStatus[order.code].shipment.id &&
                !this.orderStatus[order.code].error &&
                !this.orderStatus[order.code].shipment.purchasedAt,
        );
        if (!readyOrders.length) return;

        this.progressBar = new ProgressBar(readyOrders.length);
        this.progressBar.message = 'Purchasing shipments...';
        const purchasedAt = new Date();
        const promises = readyOrders.map(order => this.purchaseOrder(order, purchasedAt));
        await Promise.all(promises);
        this.resortOrdersByStatus();
        this.progressBar.message = `Purchased ${this.progressBar.success} shipment(s)`;
        this.step = this.progressBar.success ? 'print' : 'done';
    }

    private resortOrdersByStatus() {
        // sort the shipments like so: with invoices -> errors -> others
        this.displayOrders.sort((a, b) => {
            const aStatus = this.orderStatus[a.code];
            const bStatus = this.orderStatus[b.code];
            if (aStatus.shipment.commInvoiceUrl && !bStatus.shipment.commInvoiceUrl) return -1;
            if (!aStatus.shipment.commInvoiceUrl && bStatus.shipment.commInvoiceUrl) return 1;
            if (aStatus.error && !bStatus.error) return -1;
            if (!aStatus.error && bStatus.error) return 1;
            return 0;
        });
    }

    printLabels() {
        const fulfillmentIds = this.purchasedFulfillmentIds();
        if (!fulfillmentIds.length) return;
        openLabelsInNewWindow(fulfillmentIds as string[]);
    }

    printPickList() {
        const fulfillmentIds = this.purchasedFulfillmentIds();
        if (!fulfillmentIds.length) return;
        openPickListInNewWindow(fulfillmentIds as string[]);
    }

    private purchasedFulfillmentIds() {
        return this.displayOrders
            .map(
                order =>
                    this.orderStatus[order.code].shipment.purchasedAt &&
                    this.orderStatus[order.code]?.shipment.id,
            )
            .filter(Boolean);
    }

    private purchaseOrder(order: ShippableOrder, purchasedAt: Date): Promise<boolean> {
        const s = this.orderStatus[order.code];
        const fulfillmentId = s?.shipment.id;
        if (!fulfillmentId) return Promise.resolve(false);

        s.processing = true;
        this.cd.markForCheck();
        return this.dataService
            .mutate(TransitionFulfillmentWithCustomFieldsDocument, {
                input: {
                    id: fulfillmentId,
                    customFields: { ratePurchasedAt: purchasedAt.toISOString() },
                },
                state: 'Purchased',
            })
            .toPromise()
            .then(result => {
                if (
                    result?.transitionFulfillmentToStateWithCustomFields.__typename ===
                    'FulfillmentStateTransitionError'
                ) {
                    throw result.transitionFulfillmentToStateWithCustomFields.transitionError;
                } else if (
                    result?.transitionFulfillmentToStateWithCustomFields.__typename !== 'Fulfillment'
                ) {
                    throw result;
                }
                s.shipment.purchasedAt = purchasedAt;
                s.shipment.commInvoiceUrl =
                    result.transitionFulfillmentToStateWithCustomFields.customFields?.commInvoiceUrl;
                this.progressBar!.success++;
                return true;
            })
            .catch(e => {
                s.error = e?.message || e;
                this.progressBar!.error++;
                return false;
            })
            .finally(() => {
                s.processing = false;
                this.cd.markForCheck();
            });
    }
}

function isFreeShipping(order: ShippableOrder) {
    // @TODO: this isn't very third-party-system safe; it relies on the
    // shipping method being named something like "Free Shipping"
    return order.shippingLines.some(l => l.shippingMethod.name.includes('Free'));
}

const ACTIVE_STATES = ['Created', 'Pending'];
function getActiveFulfillment(order: ShippableOrder) {
    return (order.fulfillments || []).find(f => ACTIVE_STATES.includes(f.state));
}

class ProgressBar {
    success = 0;
    error = 0;
    message = '';
    get successPct() {
        return (this.success / this.total) * 100 || 0;
    }
    get errorPct() {
        return (this.error / this.total) * 100 || 0;
    }
    get active() {
        return this.success + this.error < this.total;
    }
    constructor(public total: number) {}
}
