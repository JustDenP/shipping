import { Component } from '@angular/core';
import {
    TimelineDisplayType,
    TimelineHistoryEntry,
    OrderDetailFragment,
    OrderHistoryEntryComponent,
} from '@vendure/admin-ui/core';

@Component({
    selector: 'fulfillment-history-entry',
    template: `
        <div class="entry-details" *ngIf="getFulfillment() as fulfillment">
            <div *ngIf="entry.data.to === 'Delivered'">
                <div class="title">
                    {{ 'order.history-fulfillment-delivered' | translate }}
                </div>
                {{ 'order.tracking-code' | translate }}: {{ fulfillment.trackingCode }}
            </div>
            <ng-container *ngIf="entry.data.to === 'Shipped'">
                <div class="title">
                    {{ 'order.history-fulfillment-shipped' | translate }}
                </div>
                {{ 'order.tracking-code' | translate }}: {{ fulfillment.trackingCode }}
            </ng-container>
            <ng-container *ngIf="entry.data.to !== 'Delivered' && entry.data.to !== 'Shipped'">
                {{
                    'order.history-fulfillment-transition'
                        | translate : { from: entry.data.from, to: entry.data.to }
                }}
            </ng-container>
            <a class="button-ghost" [routerLink]="['/extensions/easy-post/shipments', fulfillment.id]">
                {{ fulfillment.customFields.invoiceId }}
                <clr-icon shape="arrow right"></clr-icon>
            </a>
        </div>
    `,
    styles: [
        `
            .entry-details {
                padding: 10px;
            }
            .title {
                font-weight: bold;
            }
            .button-ghost {
                font-size: 0.95em !important;
                height: auto;
            }
        `,
    ],
})
export class FulfillmentHistoryEntryComponent implements OrderHistoryEntryComponent {
    order: OrderDetailFragment;
    entry: TimelineHistoryEntry;

    getDisplayType(entry: TimelineHistoryEntry): TimelineDisplayType {
        return entry.data.to === 'Delivered' ? 'success' : 'default';
    }

    getFulfillment(): NonNullable<OrderDetailFragment['fulfillments']>[number] | undefined {
        return this.order.fulfillments?.find(f => f.id == this.entry.data.fulfillmentId);
    }

    getIconShape(entry: TimelineHistoryEntry): string {
        switch (entry.data.to) {
            case 'Shipped':
                return 'truck';
            case 'Delivered':
                return 'home';
            default:
                return '';
        }
    }

    isFeatured(entry: TimelineHistoryEntry): boolean {
        return entry.data.to === 'Shipped' || entry.data.to === 'Delivered';
    }
}
