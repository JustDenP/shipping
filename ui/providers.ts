// import { gql } from '@apollo/client/core';
import 'core-js/es/promise/all-settled';
import {
    addNavMenuSection,
    registerBulkAction,
    ModalService,
    NotificationService,
    DataService,
    DialogButtonConfig,
    BulkAction,
    registerHistoryEntryComponent,
    addNavMenuItem,
    addActionBarItem,
    PageLocationId,
} from '@vendure/admin-ui/core';

import { catchError, EMPTY, filter, firstValueFrom, forkJoin, map, of, switchMap, take, tap } from 'rxjs';
import {
    AssignFulfillmentsToPickupDocument,
    CombineFulfillmentsDocument,
    CorrectOrderStatesDocument,
    EnsurePendingFulfillmentDocument,
    GetShippableOrderListQuery,
    type GetFulfillmentsQuery,
} from './generated-types';
import { openLabelsInNewWindow, openPickListInNewWindow } from './utils';
import { type ShipmentListComponent } from './components/shipment-list/shipment-list.component';
import { type ShippableOrderListComponent } from './components/shippable-order-list/shippable-order-list.component';
import { FulfillmentHistoryEntryComponent } from './components/fulfillment-history-entry.component';
import { EditStringDialogComponent } from './components/edit-string-dialog/edit-string-dialog.component';
import { FulfillmentBarcodeScanDialogComponent } from './components/fulfillment-barcode-scan-dialog/fulfillment-barcode-scan-dialog.component';
declare global {
    interface PromiseConstructor {
        allSettled<T>(promises: Array<Promise<T> | T>): Promise<Array<PromiseSettledResult<T>>>;
    }
}

interface PromiseSettledResult<T> {
    status: 'fulfilled' | 'rejected';
    value?: T;
    reason?: any;
}

type FulfillmentListItem = GetFulfillmentsQuery['fulfillments']['items'][0];
type ShippableOrder = GetShippableOrderListQuery['shippableOrders']['items'][0];

type MakeTransitionBulkActionOpts = {
    toState: FulfillmentListItem['state'];
    allowedFrom: FulfillmentListItem['state'][];
    label?: string;
    icon?: string;
    iconClass?: string;
};
function makeTransitionBulkAction({
    toState,
    allowedFrom,
    label,
    icon,
    iconClass,
}: MakeTransitionBulkActionOpts): BulkAction<FulfillmentListItem, ShipmentListComponent> {
    label = label || `Transition to ${toState}`;
    icon = icon || 'step-forward-2';
    iconClass = iconClass || '';
    return {
        location: 'shipment-list',
        label,
        icon,
        iconClass,
        isVisible: ({ selection }) => selection.every(fulfillment => allowedFrom.includes(fulfillment.state)),
        onClick: async ({ injector, selection, hostComponent }) => {
            const notificationService = injector.get(NotificationService);
            const dataService = injector.get(DataService);

            try {
                const promises = selection.map(fulfillment =>
                    firstValueFrom(dataService.order.transitionFulfillmentToState(fulfillment.id, toState)),
                );

                const results = await Promise.allSettled(promises);
                const errors = getPromiseErrors(results);
                if (errors.length) {
                    notificationService.error(`${errors.length} errors encountered: ${errors.join('\\n')}`);
                } else {
                    notificationService.success(`${results.length} updated`);
                    hostComponent.selectionManager.clearSelection();
                    hostComponent.refresh();
                }
            } catch (error) {
                notificationService.error('Error preparing shipments');
            }
        },
    } as BulkAction<FulfillmentListItem, ShipmentListComponent>;
}

function makeBarcodeScanAction(locationId: any) {
    return addActionBarItem({
        id: `${locationId}-barcode-scan-dialog`,
        label: 'fulfillment.barcode-scan-dialog.btn-open-dialog',
        locationId,
        requiresPermission: 'UpdateOrder',
        buttonColor: 'primary',
        onClick(event, { injector }) {
            injector
                .get(ModalService)
                .fromComponent(FulfillmentBarcodeScanDialogComponent, {
                    closable: true,
                    size: 'xl',
                })
                .pipe(take(1))
                .subscribe();
        },
    });
}

export default [
    registerBulkAction(
        makeTransitionBulkAction({
            toState: 'Pending',
            allowedFrom: ['Created', 'OnHold'],
            label: 'Mark for Review',
            icon: 'eye',
            iconClass: 'is-info',
        }),
    ),

    registerBulkAction({
        location: 'shipment-list',
        label: 'Print Labels',
        icon: 'printer',
        isVisible: ({ selection }) =>
            selection.every(fulfillment => fulfillment.customFields?.ratePurchasedAt),
        onClick: ({ injector, selection }) => {
            const modalService = injector.get(ModalService);
            const fulfillments = selection as FulfillmentListItem[];
            const shippedStates = ['Tendered', 'Shipped', 'Delivered'];
            const alreadyShipped = fulfillments.filter(f => shippedStates.includes(f.state)).map(f => f.id);
            const notShipped = fulfillments.filter(f => !shippedStates.includes(f.state)).map(f => f.id);
            const all = [...alreadyShipped, ...notShipped];
            if (alreadyShipped.length) {
                const plural = alreadyShipped.length > 1;
                const buttons: DialogButtonConfig<string[]>[] = [
                    { type: 'secondary', label: 'Cancel', returnValue: [] },
                ];
                let title = `${plural ? 'These have' : 'This has'} already been shipped`;
                let body = `Do you want to print the label${plural ? 's' : ''} again?`;
                if (notShipped.length) {
                    title = `Some packages have already been shipped`;
                    body = `${alreadyShipped.length} of these packages ${
                        plural ? 'has' : 'have'
                    } already been shipped. What labels do you want to print?`;
                    buttons.push(
                        { type: 'secondary', label: `Print all`, returnValue: all },
                        {
                            type: 'primary',
                            label: `Only ${notShipped.length} unshipped`,
                            returnValue: notShipped,
                        },
                    );
                } else {
                    buttons.push({ type: 'primary', label: `Print again`, returnValue: all });
                }
                modalService.dialog({ title, body, buttons }).subscribe(async response => {
                    if (response?.length) {
                        openLabelsInNewWindow(response);
                    }
                });
            } else {
                openLabelsInNewWindow(all);
            }
        },
    } as BulkAction<FulfillmentListItem, ShipmentListComponent>),
    registerBulkAction({
        location: 'shipment-list',
        label: 'Purchase & Print Labels',
        icon: 'dollar',
        iconClass: 'is-success',
        isVisible: ({ selection }) =>
            (selection as FulfillmentListItem[]).every(fulfillment => fulfillment.state === 'Pending'),
        onClick: ({ hostComponent, injector, selection }) => {
            const modalService = injector.get(ModalService);
            const notificationService = injector.get(NotificationService);
            const dataService = injector.get(DataService);
            const fulfillments = selection as FulfillmentListItem[];

            const totalCost: number = fulfillments.reduce(
                (shipCost, fulfillment) => shipCost + (fulfillment.customFields?.rateCost ?? 0),
                0,
            );

            modalService
                .dialog({
                    title: `Create and print labels for ${fulfillments.length} shipments?`,
                    body: `Expected cost: $${(totalCost / 100).toFixed(2)}`,
                    buttons: [
                        { type: 'secondary', label: 'Cancel' },
                        { type: 'primary', label: 'Yes', returnValue: true },
                    ],
                })
                .subscribe(async response => {
                    if (response) {
                        try {
                            const promises = selection.map(fulfillment =>
                                firstValueFrom(
                                    dataService.order.transitionFulfillmentToState(
                                        fulfillment.id,
                                        'Purchased',
                                    ),
                                ),
                            );
                            const results = await Promise.allSettled(promises);
                            const errors = getPromiseErrors(results);
                            if (errors.length) {
                                notificationService.error(
                                    `${errors.length} errors encountered: ${errors.join('\\n')}`,
                                );
                            } else {
                                notificationService.success(`${results.length} labels purchased`);
                                openLabelsInNewWindow(fulfillments.map(f => f.id));
                                hostComponent.selectionManager.clearSelection();
                                hostComponent.refresh();
                            }
                        } catch (error) {
                            notificationService.error('Error purchasing labels');
                        }
                    }
                });
        },
    } as BulkAction<FulfillmentListItem, ShipmentListComponent>),
    registerBulkAction({
        location: 'shipment-list',
        label: 'Add to Pickup',
        icon: 'bundle',
        iconClass: 'is-success',
        isVisible: ({ selection }) => selection.every(fulfillment => fulfillment.state === 'Purchased'),
        onClick: ({ hostComponent, injector, selection }) => {
            const dataService = injector.get(DataService);
            const modalService = injector.get(ModalService);
            const notificationService = injector.get(NotificationService);
            modalService
                .dialog({
                    title: `Add ${selection.length} shipments to a pickup?`,
                    body: `Make sure you've only selected shipments that are already or are about to be packaged.`,
                    buttons: [
                        { type: 'secondary', label: 'Cancel', returnValue: false },
                        { type: 'primary', label: 'Add to Pickup', returnValue: true },
                    ],
                })
                .pipe(
                    filter(Boolean),
                    switchMap(() =>
                        dataService.mutate(AssignFulfillmentsToPickupDocument, {
                            fulfillmentIds: selection.map(f => f.id),
                        }),
                    ),
                )
                .subscribe({
                    next: response => {
                        if (response.assignFulfillmentsToPickup) {
                            notificationService.success(`Success`);
                            hostComponent.selectionManager.clearSelection();
                            hostComponent.refresh();
                        } else {
                            notificationService.error(`Error adding to pickup: ${response}`);
                            console.error(response);
                        }
                    },
                });
        },
    } as BulkAction<FulfillmentListItem, ShipmentListComponent>),
    registerBulkAction({
        location: 'shipment-list',
        label: 'Combine Shipments',
        icon: 'shrink',
        isVisible: ({ selection }) =>
            selection.length > 1 && selection.every(fulfillment => fulfillment.state === 'Created'),
        onClick: ({ hostComponent, injector, selection }) => {
            const dataService = injector.get(DataService);
            const modalService = injector.get(ModalService);
            const notificationService = injector.get(NotificationService);
            modalService
                .dialog({
                    title: `Combine Shipments`,
                    body: `Do you really want to combine these ${selection.length} shipments?`,
                    buttons: [
                        { type: 'secondary', label: 'Cancel', returnValue: false },
                        { type: 'primary', label: 'Combine', returnValue: true },
                    ],
                })
                .pipe(
                    filter(Boolean),
                    switchMap(() =>
                        dataService.mutate(CombineFulfillmentsDocument, {
                            fulfillmentIds: selection.map(f => f.id),
                        }),
                    ),
                )
                .subscribe({
                    next: response => {
                        if (response.combineFulfillments?.__typename === 'Fulfillment') {
                            notificationService.success(`${selection.length} shipments combined`);
                            hostComponent.selectionManager.clearSelection();
                            hostComponent.refresh();
                        } else {
                            notificationService.error(`Error combining shipments: ${response}`);
                            console.error(response);
                        }
                    },
                });
        },
    } as BulkAction<FulfillmentListItem, ShipmentListComponent>),
    registerBulkAction({
        location: 'shipment-list',
        label: 'Print Pick List',
        icon: 'printer',
        onClick: ({ selection }) => {
            openPickListInNewWindow(selection.map(f => f.id));
        },
    }),
    registerBulkAction(
        makeTransitionBulkAction({
            toState: 'OnHold',
            allowedFrom: ['Created', 'Pending'],
            label: 'On Hold',
            icon: 'cursor-hand-open',
            iconClass: 'is-danger',
        }),
    ),
    registerBulkAction(makeTransitionBulkAction({ toState: 'Shipped', allowedFrom: ['Purchased'] })),
    registerBulkAction(
        makeTransitionBulkAction({ toState: 'Delivered', allowedFrom: ['Purchased', 'Shipped'] }),
    ),
    registerBulkAction(
        makeTransitionBulkAction({
            toState: 'Cancelled',
            allowedFrom: ['Created', 'Pending', 'OnHold'],
            label: 'Cancel Shipment(s)',
            icon: 'error-standard',
            iconClass: 'is-danger',
        }),
    ),
    registerBulkAction(
        makeTransitionBulkAction({
            toState: 'Cancelled',
            allowedFrom: ['Purchased', 'Tendered'],
            label: 'Refund & Cancel Shipment(s)',
            icon: 'error-standard',
            iconClass: 'is-danger',
        }),
    ),
    registerBulkAction(makeTransitionBulkAction({ toState: 'Created', allowedFrom: ['Pending', 'OnHold'] })),
    makeBarcodeScanAction('shipment-list'),
    makeBarcodeScanAction('shippable-order-list'),
    makeBarcodeScanAction('pickup-list'),
    addNavMenuItem(
        {
            id: 'menu-shippable-orders',
            label: 'Shippable Orders',
            routerLink: ['/extensions/easy-post/shippable-orders'],
            icon: 'briefcase',
            requiresPermission: 'ReadOrder',
        },
        'sales',
        'orders',
    ),
    addNavMenuSection(
        {
            id: 'fulfillment',
            label: 'Fulfillment',
            items: [
                {
                    id: 'menu-shipments',
                    label: 'Shipments',
                    routerLink: ['/extensions/easy-post/shipments'],
                    icon: 'deploy',
                    requiresPermission: 'ReadOrder',
                },
                {
                    id: 'menu-pickups',
                    label: 'Pickups',
                    routerLink: ['/extensions/easy-post/pickups'],
                    icon: 'bundle',
                    requiresPermission: 'ReadOrder',
                },
            ],
            requiresPermission: 'ReadOrder',
        },
        'affiliates-nav',
    ),
    registerHistoryEntryComponent({
        type: 'ORDER_FULFILLMENT_TRANSITION',
        component: FulfillmentHistoryEntryComponent,
    }),
    registerBulkAction({
        location: 'order-list',
        label: 'Correct Order States',
        icon: 'wrench',
        onClick: ({ injector, selection }) => {
            const dataService = injector.get(DataService);
            const notificationService = injector.get(NotificationService);
            dataService.mutate(CorrectOrderStatesDocument, { orderIds: selection.map(o => o.id) }).subscribe({
                next: response => {
                    if (!response.correctOrderStates) return;
                    const errors: string[] = [];
                    let changed = 0;
                    for (const result of response.correctOrderStates) {
                        if (result.errorMessage) {
                            errors.push(result.errorMessage);
                        } else if (result.changed) {
                            changed++;
                        }
                    }
                    if (errors.length) {
                        for (const error of errors) {
                            notificationService.error(error as string);
                        }
                    } else if (changed) {
                        notificationService.success(`${changed} orders corrected`);
                    } else {
                        notificationService.info('No orders needed correction');
                    }
                },
            });
        },
    }),
    registerBulkAction({
        location: 'shippable-order-list',
        label: 'Combine Shipments',
        icon: 'shrink',
        isVisible: ({ selection }) => {
            return selection.length > 1 && selection.every(o => o.customer?.id === selection[0].customer?.id);
        },
        onClick: async ({ injector, selection, hostComponent }) => {
            const dataService = injector.get(DataService);
            await firstValueFrom(
                dataService
                    .mutate(EnsurePendingFulfillmentDocument, {
                        orderIds: selection.map(o => o.id),
                    })
                    .pipe(),
            );
            hostComponent.refresh();
        },
    } as BulkAction<ShippableOrder, ShippableOrderListComponent>),
    registerBulkAction({
        location: 'shippable-order-list',
        label: 'Update Fulfillment Notes',
        icon: 'warning-standard',
        onClick: ({ injector, selection, hostComponent }) => {
            const dataService = injector.get(DataService);
            const notificationService = injector.get(NotificationService);
            const orderIds = selection.map(o => o.id);
            if (!orderIds.length) return;

            const modalService = injector.get(ModalService);
            modalService
                .fromComponent(EditStringDialogComponent, {
                    locals: {
                        label: 'Fulfillment Notes',
                        value: selection[0]?.customFields?.fulfillmentNotes || '',
                    },
                    closable: true,
                })
                .pipe(
                    take(1),
                    switchMap(value => {
                        if (typeof value !== 'string') {
                            return EMPTY;
                        }
                        const mutations = orderIds.map(orderId =>
                            dataService.order
                                .updateOrderCustomFields({
                                    id: orderId,
                                    customFields: {
                                        fulfillmentNotes: value,
                                    },
                                })
                                .pipe(
                                    map(() => ({ orderId, success: true })),
                                    catchError(error => of({ orderId, success: false, error })),
                                ),
                        );
                        return forkJoin(mutations).pipe(
                            tap(results => {
                                const successCount = results.filter(r => r.success).length;
                                const failureCount = results.length - successCount;
                                if (failureCount === 0) {
                                    notificationService.success(
                                        `Successfully updated ${successCount} orders`,
                                    );
                                } else {
                                    notificationService.error(
                                        `Updated ${successCount} orders, failed to update ${failureCount} orders`,
                                    );
                                }
                                hostComponent.refresh$?.next(void 0);
                            }),
                        );
                    }),
                )
                .subscribe();
        },
    }),
];

function getPromiseErrors(results: PromiseSettledResult<any>[]): string[] {
    return results
        .map(res => {
            if (res.status === 'rejected') {
                return res.reason;
            }
            if (res.value.transitionFulfillmentToState.__typename === 'FulfillmentStateTransitionError') {
                return res.value.transitionFulfillmentToState.transitionError;
            }
            return null;
        })
        .filter(x => x !== null) as string[];
}
