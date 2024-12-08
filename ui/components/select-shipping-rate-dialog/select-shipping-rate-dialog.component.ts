import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { DataService, Dialog } from '@vendure/admin-ui/core';
import { map, Observable } from 'rxjs';

import {
    CarrierWithRates,
    GetFulfillmentAvailableShippingRatesDocument,
    GetUnfilledOrderAvailableShippingRatesDocument,
} from '../../generated-types';

type ServiceRate = CarrierWithRates['services'][number];
type CarrierWithRate = Omit<CarrierWithRates, 'services'> & { service: ServiceRate };
@Component({
    selector: 'ep-select-shipping-rate-dialog',
    templateUrl: './select-shipping-rate-dialog.component.html',
    styleUrls: ['./select-shipping-rate-dialog.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SelectShippingRateDialogComponent implements OnInit, Dialog<CarrierWithRate> {
    resolveWith: (result?: CarrierWithRate) => void;
    availableServices$: Observable<CarrierWithRate[]>;
    fulfillmentId?: string;
    orderId?: string;

    constructor(private dataService: DataService) {}

    ngOnInit(): void {
        if (!this.fulfillmentId && !this.orderId) {
            return;
        }
        if (this.fulfillmentId) {
            this.availableServices$ = this.dataService
                .query(GetFulfillmentAvailableShippingRatesDocument, { id: this.fulfillmentId })
                .mapSingle(({ fulfillmentAvailableShippingRates }) =>
                    Object.values(fulfillmentAvailableShippingRates).flatMap(carrier =>
                        carrier.services.map(service => ({ ...carrier, services: void 0, service })),
                    ),
                )
                .pipe(map(rates => rates.sort((a, b) => a.service.shipmentCost - b.service.shipmentCost)));
        } else if (this.orderId) {
            this.availableServices$ = this.dataService
                .query(GetUnfilledOrderAvailableShippingRatesDocument, { orderId: this.orderId })
                .mapSingle(({ unfulfilledOrderRates }) =>
                    unfulfilledOrderRates
                        ? Object.values(unfulfilledOrderRates).flatMap(carrier =>
                              carrier.services.map(service => ({ ...carrier, services: void 0, service })),
                          )
                        : [],
                )
                .pipe(map(rates => rates.sort((a, b) => a.service.shipmentCost - b.service.shipmentCost)));
        }
    }

    cancel() {
        this.resolveWith();
    }
}
