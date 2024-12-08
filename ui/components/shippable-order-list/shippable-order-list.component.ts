import { ChangeDetectionStrategy, Component, OnDestroy, OnInit } from '@angular/core';
import {
    ChannelService,
    Customer,
    getOrderStateTranslationToken,
    LogicalOperator,
    ModalService,
    NotificationService,
    OrderListOptions,
    OrderType,
    ServerConfigService,
    TypedBaseListComponent,
    UpdateOrderCustomFieldsDocument,
} from '@vendure/admin-ui/core';
import { distinctUntilChanged, map, tap, shareReplay, take, switchMap, takeUntil } from 'rxjs/operators';
import {
    GetShippableOrderListDocument,
    GetShippableOrderListQuery,
    GetVariantBasicsWithStockDocument,
    UpdateFulfillmentShippingDetailsDocument,
} from '../../generated-types';
import { BehaviorSubject, combineLatest, firstValueFrom, Observable } from 'rxjs';
import { checkOrders, OrderCheckResult } from './checkOrders';
import { FastFulfillOrdersDialogComponent } from '../fast-fulfill-orders-dialog/fast-fulfill-orders-dialog.component';
import { SelectShippingRateDialogComponent } from '../select-shipping-rate-dialog/select-shipping-rate-dialog.component';
import { EditStringDialogComponent } from '../edit-string-dialog/edit-string-dialog.component';
import { formatDate } from '../../utils';

type ProductInfo = Record<
    string,
    {
        featuredAsset: string;
        stockOnHand: number;
        stockAllocated: number;
    }
>;

type ShippableOrder = GetShippableOrderListQuery['shippableOrders']['items'][number];
const F_ACTIVE_STATES = ['Created', 'Pending', 'OnHold'];

@Component({
    selector: 'ep-shippable-order-list',
    templateUrl: './shippable-order-list.component.html',
    styleUrls: ['./shippable-order-list.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ShippableOrderListComponent
    extends TypedBaseListComponent<typeof GetShippableOrderListDocument, 'shippableOrders'>
    implements OnInit, OnDestroy
{
    formatDate = formatDate;
    dataTableListId = 'ep-shippable-order-list';
    orderStates = this.serverConfigService.getOrderProcessStates().map(s => s.name);
    showSidebar = false;
    showSidebar$ = new BehaviorSubject(this.showSidebar);
    private refreshProductInfo$ = new BehaviorSubject<void>(void 0);
    protected productInfo$: Observable<ProductInfo>;
    private orderedSelectedItems$: Observable<ShippableOrder[]>;
    protected orderCheckResult$: Observable<OrderCheckResult>;
    protected selectedOrderNotes$: Observable<ShippableOrder[]>;
    protected customerOrderCount: { [id: Customer['id']]: number } = {};
    protected combinedOrders: { [id: ShippableOrder['id']]: boolean } = {};

    readonly OrderType = OrderType;
    readonly customFields = this.getCustomFieldConfig('Order');
    readonly filters = this.createFilterCollection()
        .addIdFilter()
        .addDateFilters()
        .addFilter({
            name: 'active',
            type: { kind: 'boolean' },
            label: 'order.filter-is-active',
            filterField: 'active',
        })
        .addFilter({
            name: 'totalWithTax',
            type: { kind: 'number', inputType: 'currency', currencyCode: 'USD' },
            label: 'order.total',
            filterField: 'totalWithTax',
        })
        .addFilter({
            name: 'state',
            type: {
                kind: 'select',
                options: this.orderStates.map(s => ({ value: s, label: getOrderStateTranslationToken(s) })),
            },
            label: 'order.state',
            filterField: 'state',
        })
        .addFilter({
            name: 'type',
            type: {
                kind: 'select',
                options: [
                    { value: OrderType.Regular, label: 'order.order-type-regular' },
                    { value: OrderType.Aggregate, label: 'order.order-type-aggregate' },
                    { value: OrderType.Seller, label: 'order.order-type-seller' },
                ],
            },
            label: 'order.order-type',
            filterField: 'type',
        })
        .addFilter({
            name: 'orderPlacedAt',
            type: { kind: 'dateRange' },
            label: 'order.placed-at',
            filterField: 'orderPlacedAt',
        })
        .addFilter({
            name: 'customerLastName',
            type: { kind: 'text' },
            label: 'customer.last-name',
            filterField: 'customerLastName',
        })
        .addFilter({
            name: 'transactionId',
            type: { kind: 'text' },
            label: 'order.transaction-id',
            filterField: 'transactionId',
        })
        .addCustomFieldFilters(this.customFields)
        .connectToRoute(this.route);

    readonly sorts = this.createSortCollection()
        .defaultSort('orderPlacedAt', 'ASC')
        .addSort({ name: 'id' })
        .addSort({ name: 'createdAt' })
        .addSort({ name: 'updatedAt' })
        .addSort({ name: 'orderPlacedAt' })
        .addSort({ name: 'customerLastName' })
        .addSort({ name: 'state' })
        .addSort({ name: 'totalWithTax' })
        .addCustomFieldSorts(this.customFields)
        .connectToRoute(this.route);

    canCreateDraftOrder = false;
    private activeChannelIsDefaultChannel = false;

    constructor(
        protected serverConfigService: ServerConfigService,
        private channelService: ChannelService,
        private notificationService: NotificationService,
        private modalService: ModalService,
    ) {
        super();
        super.configure({
            document: GetShippableOrderListDocument,
            getItems: result => result.shippableOrders,
            setVariables: (skip, take) =>
                this.createQueryOptions(skip, take, this.searchTermControl.value) as any,
            refreshListOnChanges: [this.filters.valueChanges, this.sorts.valueChanges],
        });
        this.route.queryParamMap.pipe(take(1)).subscribe(params => {
            const perPage = params.get('perPage') || '100';
            this.setItemsPerPage(+perPage);
        });
    }

    ngOnInit() {
        super.ngOnInit();
        this.items$.pipe(takeUntil(this.destroy$)).subscribe(items => {
            this.customerOrderCount = {};
            this.combinedOrders = {};
            for (const item of items) {
                const custId = item.customer?.id || '';
                this.customerOrderCount[custId] = (this.customerOrderCount[custId] || 0) + 1;
                this.combinedOrders[item.id] = !!this.getCombinedFulfillment(item);
            }
        });
        this.orderedSelectedItems$ = combineLatest([
            this.items$,
            this.selectionManager.selectionChanges$,
            this.showSidebar$,
        ]).pipe(
            map(([items, selectedItems, showSidebar]) => {
                if (!showSidebar) {
                    return [];
                }
                const selected: ShippableOrder[] = selectedItems;
                const selectedMap = new Map(selected.map(i => [i.id, i]));
                const orderedSelected = items.filter(i => selectedMap.has(i.id));
                return orderedSelected;
            }),
            distinctUntilChanged(
                (prev, cur) => prev.map(orderStatusStr).join(',') === cur.map(orderStatusStr).join(','),
            ),
            shareReplay(1),
        );
        this.selectedOrderNotes$ = this.orderedSelectedItems$.pipe(
            map(orders =>
                orders.filter(o => o.customFields?.customerNotes || o.customFields?.fulfillmentNotes),
            ),
        );
        const isDefaultChannel$ = this.channelService.defaultChannelIsActive$.pipe(
            tap(isDefault => (this.activeChannelIsDefaultChannel = isDefault)),
        );
        super.refreshListOnChanges(this.filters.valueChanges, this.sorts.valueChanges, isDefaultChannel$);
        this.productInfo$ = this.refreshProductInfo$.pipe(
            switchMap(() => this.dataService.query(GetVariantBasicsWithStockDocument).stream$),
            takeUntil(this.destroy$),
            map(result => {
                if (result.productVariants.__typename === 'ProductVariantList') {
                    const productInfo = {};
                    for (const variant of result.productVariants.items) {
                        const stockOnHand =
                            variant.stockLevels.reduce((acc, sl) => acc + sl.stockOnHand, 0) ?? 0;
                        const stockAllocated =
                            variant.stockLevels.reduce((acc, sl) => acc + sl.stockAllocated, 0) ?? 0;
                        productInfo[variant.sku] = {
                            stockOnHand,
                            stockAllocated,
                            featuredAsset: variant.featuredAsset || variant.product.featuredAsset || '',
                        };
                    }
                    return productInfo;
                } else {
                    this.notificationService.error(
                        'Unable to fetch product stock information; unable to process orders.',
                    );
                    return {};
                }
            }),
            shareReplay(1),
        );
        this.orderCheckResult$ = combineLatest([this.productInfo$, this.orderedSelectedItems$]).pipe(
            map(([productInfo, selectedItems]) => checkOrders(selectedItems, productInfo)),
            shareReplay(1),
        );
    }

    ngOnDestroy() {
        super.ngOnDestroy();
    }

    toggleSidebar() {
        this.showSidebar = !this.showSidebar;
        this.showSidebar$.next(this.showSidebar);
    }

    removeOrderSelection(orderId: string) {
        this.selectionManager.toggleSelection({ id: orderId });
    }

    removeUnfillableOrders(results: OrderCheckResult) {
        for (const result of results.errors) {
            if (result.type === 'insufficient-stock') {
                this.removeOrderSelection(result.id);
            }
        }
    }

    async selectShippingMethod(orderOrId: string | ShippableOrder) {
        let refOrder: ShippableOrder;
        if (typeof orderOrId === 'string') {
            refOrder = this.selectionManager.selection.find(o => o.id === orderOrId);
        } else {
            refOrder = orderOrId;
        }
        if (!refOrder) return;
        const orderId = refOrder.id;
        const fulfillment = this.getCombinedFulfillment(refOrder);

        const result = await firstValueFrom(
            this.modalService.fromComponent(SelectShippingRateDialogComponent, {
                locals: fulfillment ? { fulfillmentId: fulfillment.id } : { orderId },
                size: 'xl',
            }),
        );
        if (!result) return;
        const carrierCode = result.code;
        const carrierId = result.id;
        const serviceCode = result.service.serviceCode;
        const serviceName = result.service.serviceName;

        const ordersToUpdate = fulfillment ? fulfillment.orders.map(o => o.id) : [orderId];
        const updatePromises: Promise<any>[] = [];
        // if this was a combined shipment, we need to update the custom fields on
        // the combined fulfillment as well as each of the orders
        if (fulfillment) {
            updatePromises.push(
                firstValueFrom(
                    this.dataService.mutate(UpdateFulfillmentShippingDetailsDocument, {
                        id: fulfillment.id,
                        input: {
                            carrierCode,
                            carrierId,
                            serviceCode,
                            serviceName,
                            rateId: result.service.id || '',
                            rateCost: Math.round(
                                (result.service.shipmentCost + result.service.otherCost / 2) * 100,
                            ),
                        },
                    }),
                ),
            );
        }
        updatePromises.push(
            ...ordersToUpdate.map(orderId =>
                firstValueFrom(
                    this.dataService.mutate(UpdateOrderCustomFieldsDocument, {
                        input: {
                            id: orderId,
                            customFields: {
                                carrierCode,
                                carrierId,
                                serviceCode,
                                serviceName,
                            },
                        },
                    }),
                ),
            ),
        );
        await Promise.allSettled(updatePromises);
        this.refresh$.next(void 0);
    }

    protected fulfillOrders() {
        this.orderedSelectedItems$
            .pipe(
                take(1),
                switchMap(orders => {
                    return this.modalService.fromComponent(FastFulfillOrdersDialogComponent, {
                        locals: { orders },
                        size: 'xl',
                    });
                }),
            )
            .subscribe({
                next: wasUsed => {
                    if (wasUsed) {
                        this.refresh$.next(void 0);
                        this.refreshProductInfo$.next(void 0);
                    }
                },
            });
    }

    private createQueryOptions(
        // eslint-disable-next-line @typescript-eslint/no-shadow
        skip: number,
        take: number,
        searchTerm: string | null,
    ): { options: OrderListOptions } {
        let filterInput = this.filters.createFilterInput();
        if (this.activeChannelIsDefaultChannel) {
            filterInput = {
                ...(filterInput ?? {}),
            };
        }
        if (searchTerm) {
            filterInput = {
                code: {
                    contains: searchTerm,
                },
                customerEmail: {
                    contains: searchTerm,
                },
                customerLastName: {
                    contains: searchTerm,
                },
                transactionId: {
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

    getShippingMethod(order: ShippableOrder) {
        if (order.shippingLines.length) {
            return order.shippingLines.map(shippingLine => shippingLine.shippingMethod.name).join(', ');
        } else {
            return '';
        }
    }

    getCombinedFulfillment(order: ShippableOrder) {
        return (order.fulfillments || [])?.find(
            f => f.orders.length > 1 && F_ACTIVE_STATES.includes(f.state),
        );
    }

    editFulfillmentNotes(order: ShippableOrder) {
        this.modalService
            .fromComponent(EditStringDialogComponent, {
                locals: {
                    label: 'Fulfillment Notes',
                    value: order.customFields?.fulfillmentNotes || '',
                },
                closable: true,
            })
            .pipe(take(1))
            .subscribe({
                next: result => {
                    if (typeof result === 'string') {
                        this.dataService
                            .mutate(UpdateOrderCustomFieldsDocument, {
                                input: {
                                    id: order.id,
                                    customFields: {
                                        fulfillmentNotes: result,
                                    },
                                },
                            })
                            .subscribe({
                                next: () => this.refresh$.next(void 0),
                            });
                    }
                },
            });
    }
}

function orderStatusStr(order: ShippableOrder) {
    return `${order.id}-${order.state}-${order.customFields?.carrierCode}-${order.customFields?.serviceCode}`;
}
