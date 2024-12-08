import { NgModule } from '@angular/core';
import { RouterModule } from '@angular/router';
import { SharedModule } from '@vendure/admin-ui/core';
import { PickupListComponent } from './components/pickup-list/pickup-list.component';
import { PickupDetailComponent } from './components/pickup-detail/pickup-detail.component';
import { ShipmentListComponent } from './components/shipment-list/shipment-list.component';
import { ShipmentDetailComponent } from './components/shipment-detail/shipment-detail.component';
import { ShippableOrderListComponent } from './components/shippable-order-list/shippable-order-list.component';
import { SelectShippingRateDialogComponent } from './components/select-shipping-rate-dialog/select-shipping-rate-dialog.component';
import { EditStringDialogComponent } from './components/edit-string-dialog/edit-string-dialog.component';
import { FastFulfillOrdersDialogComponent } from './components/fast-fulfill-orders-dialog/fast-fulfill-orders-dialog.component';
import { FulfillmentBarcodeScanDialogComponent } from './components/fulfillment-barcode-scan-dialog/fulfillment-barcode-scan-dialog.component';

@NgModule({
    imports: [
        SharedModule,
        RouterModule.forChild([
            {
                path: 'shippable-orders',
                pathMatch: 'full',
                component: ShippableOrderListComponent,
                data: { breadcrumb: 'Orders' },
            },
            {
                path: 'shipments',
                pathMatch: 'full',
                component: ShipmentListComponent,
                data: { breadcrumb: 'Shipments' },
            },
            {
                path: 'shipments/:id',
                component: ShipmentDetailComponent,
                data: { breadcrumb: 'Shipment Details' },
            },
            {
                path: 'pickups',
                pathMatch: 'full',
                component: PickupListComponent,
                data: { breadcrumb: 'Pickups' },
            },
            {
                path: 'pickups/:id',
                component: PickupDetailComponent,
                data: { breadcrumb: 'Pickup Details' },
            },
        ]),
    ],
    declarations: [
        EditStringDialogComponent,
        FastFulfillOrdersDialogComponent,
        FulfillmentBarcodeScanDialogComponent,
        ShipmentListComponent,
        ShipmentDetailComponent,
        ShippableOrderListComponent,
        SelectShippingRateDialogComponent,
        PickupListComponent,
        PickupDetailComponent,
    ],
})
export class ShipmentUIModule {}
