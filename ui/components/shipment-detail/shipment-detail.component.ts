import { ChangeDetectionStrategy, ChangeDetectorRef, Component, Injector, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import {
    DataService,
    NotificationService,
    OrderLine,
    PageMetadataService,
    TransitionFulfillmentToStateDocument,
} from '@vendure/admin-ui/core';
import {
    GetFulfillmentDocument,
    GetFulfillmentQuery,
    GetFulfillmentQueryVariables,
    RemoveFromPickupDocument,
    UpdateFulfillmentShippingDetailsDocument,
} from '../../generated-types';
import { openLabelsInNewWindow, openSelectShippingRateDialog } from '../../utils';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';

type FulfillmentObj = GetFulfillmentQuery['fulfillment'];
@Component({
    selector: 'ep-shipment-detail',
    templateUrl: './shipment-detail.component.html',
    styleUrls: ['./shipment-detail.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ShipmentDetailComponent implements OnInit {
    fulfillmentId = '';
    fulfillment: FulfillmentObj;
    dimensionsForm: FormGroup;
    updatingDimensions = false;

    constructor(
        private route: ActivatedRoute,
        private dataService: DataService,
        private formBuilder: FormBuilder,
        private injector: Injector,
        private cd: ChangeDetectorRef,
        private notificationService: NotificationService,
        private pageMetadataService: PageMetadataService,
    ) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        this.fulfillmentId = this.route.snapshot.paramMap.get('id')!;

        const dimensionFields = {
            length: [0, Validators.required],
            width: [0, Validators.required],
            height: [0, Validators.required],
            weight: [0, Validators.required],
        };
        this.dimensionsForm = this.formBuilder.group(dimensionFields);
        this.dimensionsForm.disable();
    }

    ngOnInit(): void {
        this.getFulfillment();
    }

    protected setFormValues(entity: FulfillmentObj) {
        if (!entity?.customFields) return;
        this.dimensionsForm.patchValue({
            length: entity.customFields?.length || '',
            width: entity.customFields?.width || '',
            height: entity.customFields?.height || '',
            weight: entity.customFields?.weight || '',
        });
    }
    setEditDimensions() {
        this.dimensionsForm.enable();
    }
    cancelEditDimensions() {
        this.setFormValues(this.fulfillment);
        this.dimensionsForm.disable();
    }
    updateDimensions() {
        if (!this.fulfillmentId) return;
        this.updatingDimensions = true;
        return this.dataService
            .mutate(UpdateFulfillmentShippingDetailsDocument, {
                id: this.fulfillmentId,
                input: {
                    length: Number(this.dimensionsForm.value.length),
                    width: Number(this.dimensionsForm.value.width),
                    height: Number(this.dimensionsForm.value.height),
                    weight: Number(this.dimensionsForm.value.weight),
                },
            })
            .subscribe({
                next: response => {
                    if (response.updateFulfillmentShippingDetails.__typename === 'Fulfillment') {
                        this.dimensionsForm.disable();
                        this.getFulfillment();
                        this.updatingDimensions = false;
                        this.cd.markForCheck();
                    }
                },
                error: error => {
                    this.updatingDimensions = false;
                    this.cd.markForCheck();
                },
            });
    }

    getLineDiscounts(line: OrderLine) {
        return line.discounts.filter(d => d.type === 'PROMOTION');
    }
    getOrderDiscounts() {
        const orderDiscountsMap: Record<string, { name: string; amount: number }> = {};
        const orderDiscountsByLine =
            this.fulfillment?.lines
                .flatMap(line => line.orderLine.discounts)
                .filter(d => d.type !== 'PROMOTION') || [];
        for (const discount of orderDiscountsByLine) {
            const desc = discount.description;
            if (orderDiscountsMap[desc]) {
                orderDiscountsMap[desc].amount += discount.amount;
            } else {
                orderDiscountsMap[desc] = {
                    name: desc,
                    amount: discount.amount,
                };
            }
        }
        return Object.values(orderDiscountsMap);
    }
    getSubtotal() {
        const linesWithDiscounts =
            this.fulfillment?.lines.reduce((acc, line) => acc + line.orderLine.discountedLinePrice, 0) || 0;
        const orderDiscounts = this.getOrderDiscounts().reduce((acc, discount) => acc + discount.amount, 0);
        return linesWithDiscounts + orderDiscounts;
    }
    getTotalTax() {
        return this.fulfillment?.lines.reduce(
            (acc, line) =>
                acc + (line.orderLine.discountedLinePriceWithTax - line.orderLine.discountedLinePrice),
            0,
        );
    }
    getShippingCollected() {
        return this.fulfillment?.orders.reduce((acc, order) => acc + order.shippingWithTax, 0);
    }
    printLabel() {
        if (this.fulfillment) {
            openLabelsInNewWindow([this.fulfillment.id]);
        }
    }
    printCommercialInvoice() {
        if (this.fulfillment && this.fulfillment.customFields?.commInvoiceUrl) {
            window.open(this.fulfillment.customFields.commInvoiceUrl, '_blank');
        }
    }
    openSelectRateDialog() {
        return openSelectShippingRateDialog(this.injector, this.fulfillmentId).subscribe({
            next: response => {
                // Handle the response from the mutation
                console.log('Mutation successful:', response);
                this.getFulfillment();
            },
            error: error => {
                this.notificationService.error('Error:', error);
            },
        });
    }
    removeFromPickup() {
        if (this.fulfillment?.easypostPickup?.state !== 'Open') {
            return;
        }
        this.dataService
            .mutate(RemoveFromPickupDocument, {
                id: this.fulfillment.easypostPickup.id,
                fulfillmentIds: [this.fulfillment.id],
            })
            .subscribe({
                next: response => {
                    if (response.removeFulfillmentsFromPickup.__typename === 'Pickup') {
                        this.getFulfillment();
                    }
                },
            });
    }
    transitionToState(state: string) {
        if (!this.fulfillment) {
            return;
        }
        this.dataService
            .mutate(TransitionFulfillmentToStateDocument, {
                id: this.fulfillment.id,
                state,
            })
            .subscribe({
                next: response => {
                    if (response.transitionFulfillmentToState.__typename === 'Fulfillment') {
                        this.getFulfillment();
                    } else if (
                        response.transitionFulfillmentToState.__typename === 'FulfillmentStateTransitionError'
                    ) {
                        this.notificationService.error(response.transitionFulfillmentToState.transitionError);
                    }
                },
                error: error => {
                    this.notificationService.error('Error:', error);
                },
            });
    }

    getFulfillment() {
        return this.dataService
            .query<GetFulfillmentQuery, GetFulfillmentQueryVariables>(GetFulfillmentDocument, {
                id: this.fulfillmentId,
            })
            .single$.subscribe({
                next: data => {
                    if (data) {
                        this.fulfillment = data.fulfillment;
                        this.setFormValues(this.fulfillment);
                        this.cd.markForCheck();
                        if (this.fulfillment?.customFields?.invoiceId) {
                            this.pageMetadataService.setTitle(this.fulfillment.customFields.invoiceId);
                        }
                    } else {
                        console.warn('No data returned for fulfillment ID:', this.fulfillmentId);
                    }
                },
                error: error => {
                    console.error('Error fetching fulfillment detail:', error);
                    this.notificationService.error('Error fetching fulfillment details'); // Display notification on error
                },
                complete: () => {
                    console.log('Fulfillment detail fetching complete');
                },
            });
    }
}
