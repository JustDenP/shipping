import { registerRouteComponent } from '@vendure/admin-ui/core';
import { ShipmentListComponent } from './components/shipment-list/shipment-list.component';
import { ShipmentDetailComponent } from './components/shipment-detail/shipment-detail.component';
import { ShippableOrderListComponent } from './components/shippable-order-list/shippable-order-list.component';
import { PickupListComponent } from './components/pickup-list/pickup-list.component';
import { PickupDetailComponent } from './components/pickup-detail/pickup-detail.component';

export default [
    registerRouteComponent({
        path: 'shippable-orders',
        component: ShippableOrderListComponent,
        breadcrumb: 'Shippable Orders',
        title: 'Shippable Orders',
    }),
    registerRouteComponent({
        path: 'shipments',
        component: ShipmentListComponent,
        breadcrumb: 'Shipments',
        title: 'Shipments',
    }),
    registerRouteComponent({
        path: 'shipments/:id',
        component: ShipmentDetailComponent,
        breadcrumb: [
            {
                label: 'Shipments',
                link: ['/extensions/easy-post/shipments'],
            },
            {
                label: 'Details',
                link: [],
            },
        ],
        title: 'Shipment Details',
    }),

    registerRouteComponent({
        path: 'pickups',
        component: PickupListComponent,
        breadcrumb: 'Pickups',
        title: 'Pickups',
    }),
    registerRouteComponent({
        path: 'pickups/:id',
        component: PickupDetailComponent,
        breadcrumb: [
            {
                label: 'Pickups',
                link: ['/extensions/easy-post/pickups'],
            },
            {
                label: 'Details',
                link: [],
            },
        ],
        title: 'Pickup Details',
    }),
];
