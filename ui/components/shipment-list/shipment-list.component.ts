import { ChangeDetectionStrategy, Component, Injector } from '@angular/core';
import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker';
import { map, take } from 'rxjs/operators';
import { getOrderStateTranslationToken, SortOrder, TypedBaseListComponent } from '@vendure/admin-ui/core';
import {
    GetFulfillmentsQuery,
    GetFulfillmentsDocument,
    FulfillmentListOptions,
    LogicalOperator,
    FulfillmentCustomFields,
} from '../../generated-types';
import { Router } from '@angular/router';
import { formatDate, openSelectShippingRateDialog } from '../../utils';

type FulfillmentObj = GetFulfillmentsQuery['fulfillments']['items'][number];

@Component({
    selector: 'ep-shipment-list',
    templateUrl: './shipment-list.component.html',
    styleUrls: ['./shipment-list.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ShipmentListComponent extends TypedBaseListComponent<
    typeof GetFulfillmentsDocument,
    'fulfillments'
> {
    formatDate = formatDate;
    customFields = this.getCustomFieldConfig('Fulfillment');
    selectedFulfillments$ = this.selectionManager.selectionChanges$.pipe(
        map(selection => (selection.length ? (selection as FulfillmentObj[]) : null)),
    );

    constructor(private injector: Injector, protected router: Router) {
        super();
        super.configure({
            document: GetFulfillmentsDocument,
            getItems: data => data.fulfillments,
            setVariables: (skip, take) => this.createQueryOptions(skip, take, this.searchTermControl.value),
            refreshListOnChanges: [this.filters.valueChanges, this.sorts.valueChanges],
        });
        this.sorts.defaultSort('createdAt', SortOrder.DESC);
        this.route.queryParamMap.pipe(take(1)).subscribe(params => {
            const perPage = params.get('perPage') || '100';
            this.setItemsPerPage(+perPage);
        });
    }

    readonly filters = this.createFilterCollection()
        .addDateFilters()
        .addFilter({
            name: 'state',
            type: {
                kind: 'select',
                options: [
                    'Created',
                    'Pending',
                    'Purchased',
                    'Tendered',
                    'Shipped',
                    'Delivered',
                    'OnHold',
                    'Cancelled',
                ].map(value => ({ value, label: getOrderStateTranslationToken(value) })),
            },
            label: 'State',
            filterField: 'state',
        })
        .addFilter({
            name: 'pickupState',
            type: { kind: 'text' },
            label: 'Pickup State',
            filterField: 'pickupState',
        })
        .addCustomFieldFilters(this.customFields)
        .connectToRoute(this.route);

    readonly sorts = this.createSortCollection()
        .addSort({ name: 'createdAt' })
        .addSort({ name: 'updatedAt' })
        .addSort({ name: 'customerLastName' })
        .addSort({ name: 'orderCode' })
        .addSort({ name: 'method' })
        .addSort({ name: 'state' })
        .addCustomFieldSorts(this.customFields)
        .connectToRoute(this.route);

    /**
     * Using `.addCustomSortFields` makes custom fields sortable, but doesn't
     * expand the type of `this.sorts` to know what they are, so we can't use
     * the normal `sorts.get('key')` to get the sort for a * custom field.
     */
    protected getCustomFieldSort(key: keyof FulfillmentCustomFields) {
        return this.sorts.get(key as any);
    }

    navigateToShipmentDetail(id: string) {
        this.router.navigate([`./${id}`], { relativeTo: this.route });
    }

    getShippingCollected(item: FulfillmentObj) {
        return item.orders.reduce((acc, order) => acc + order.shipping, 0);
    }

    getItemQuantity(fulfillment: FulfillmentObj) {
        return fulfillment.lines.reduce((acc, line) => acc + line.quantity, 0);
    }
    canChangeShippingRate(fulfillment: FulfillmentObj) {
        return !(
            !!fulfillment?.customFields?.ratePurchasedAt ||
            ['Shipped', 'Delivered', 'Cancelled'].includes(fulfillment.state)
        );
    }
    openSelectRateDialog(fulfillment: FulfillmentObj) {
        if (!this.canChangeShippingRate(fulfillment)) {
            return;
        }
        openSelectShippingRateDialog(this.injector, fulfillment.id).subscribe({
            next: response => {
                // Handle the response from the mutation
                console.log('Mutation successful:', response);
                this.refresh();
                this.selectionManager.clearSelection();
            },
            error: error => {
                console.error('Error:', error);
            },
        });
    }

    formatWeight(item: FulfillmentObj) {
        // weight is in oz
        const totalOz = Math.round(item.customFields?.weight ?? 1);
        const lbs = Math.floor(totalOz / 16);
        const oz = totalOz % 16;

        if (lbs > 0 && oz > 0) {
            return `${lbs} lbs ${oz} oz`;
        } else if (lbs > 0) {
            return `${lbs} lbs`;
        } else {
            return `${oz} oz`;
        }
    }

    private createQueryOptions(
        // eslint-disable-next-line @typescript-eslint/no-shadow
        skip: number,
        take: number,
        searchTerm: string | null,
    ): { options: FulfillmentListOptions } {
        let filterInput = this.filters.createFilterInput();
        if (searchTerm) {
            filterInput = {
                customerLastName: {
                    contains: searchTerm,
                },
                customerEmail: {
                    contains: searchTerm,
                },
                productVariantSku: {
                    contains: searchTerm,
                },
                invoiceId: {
                    contains: searchTerm,
                },
                carrierCode: {
                    contains: searchTerm,
                },
                trackingCode: {
                    contains: searchTerm,
                },
            };
        }
        return {
            options: {
                skip,
                take,
                filter: {
                    ...(filterInput ?? {}),
                },
                filterOperator: searchTerm ? LogicalOperator.OR : LogicalOperator.AND,
                sort: this.sorts.createSortInput(),
            },
        };
    }
}
