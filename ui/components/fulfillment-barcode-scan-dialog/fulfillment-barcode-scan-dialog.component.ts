import {
    AfterViewInit,
    ChangeDetectionStrategy,
    ChangeDetectorRef,
    Component,
    ElementRef,
    ViewChild,
} from '@angular/core';
import { DataService, Dialog, NotificationService } from '@vendure/admin-ui/core';
import {
    AssignFulfillmentsToPickupDocument,
    ShippingLabelScannedDocument,
    ShippingLabelScannedMutation,
    UndoShippingLabelScanDocument,
} from '../../generated-types';
import { take } from 'rxjs';
import * as Tone from 'tone';
import { carrierSound, errorSound } from '../../sound.utils';

type Fulfillment = ShippingLabelScannedMutation['shippingLabelScanned'];
type ScanResult = {
    barcode: string;
    fulfillment: Fulfillment;
    status: 'scanned' | 'added-to-pickup' | 'undone';
};
type Failure = { msg: string; type: 'warning' | 'danger' };
@Component({
    selector: 'ep-fulfillment-barcode-scan-dialog',
    templateUrl: './fulfillment-barcode-scan-dialog.component.html',
    styleUrls: ['./fulfillment-barcode-scan-dialog.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FulfillmentBarcodeScanDialogComponent implements Dialog<string[]>, AfterViewInit {
    resolveWith: (scannedFulfillmentIds?: string[]) => void;
    results: ScanResult[] = [];
    failures: Failure[] = [];

    @ViewChild('barcodeInput') barcodeInput: ElementRef;
    protected barcodeInputValue = '';

    /** { barcode: fulfillment } */
    private processedBarcodes = {} as Record<string, Fulfillment>;

    constructor(
        private cd: ChangeDetectorRef,
        private dataService: DataService,
        private notificationService: NotificationService,
    ) {}

    close() {
        this.resolveWith(Object.values(this.processedBarcodes).map(f => f.id));
    }

    ngAfterViewInit(): void {
        this.focusInput();
    }

    focusInput() {
        setTimeout(() => this.barcodeInput.nativeElement.focus(), 0);
    }

    async barcodeScanned() {
        const barcode = this.barcodeInputValue.trim();
        this.barcodeInputValue = '';
        if (!barcode) return;

        try {
            if (barcode in this.processedBarcodes) {
                const fmt = this.processedBarcodes[barcode];
                carrierSound(fmt.customFields?.carrierCode, Tone.DuoSynth);
                this.notificationService.warning(`You've already scanned this package`);
                return;
            }

            const fulfillment = await this.getFulfillment(barcode);

            if (!fulfillment) {
                errorSound();
                this.addFailure({ msg: `No fulfillment found for barcode: ${barcode}`, type: 'danger' });
                return;
            }
            const result: ScanResult = { fulfillment, barcode, status: 'scanned' };
            this.results.push(result);
            this.processedBarcodes[barcode] = fulfillment;

            if (fulfillment.easypostPickup) {
                errorSound(Tone.MembraneSynth);
                this.addFailure({ msg: `This package has already been added to a pickup`, type: 'warning' });
                return;
            } else if (fulfillment.state !== 'Purchased') {
                errorSound(Tone.MembraneSynth);
                this.addFailure({
                    msg: `This package is in the wrong state to add to a pickup (${fulfillment.state})`,
                    type: 'warning',
                });
                return;
            }
            // if we got here, the fulfillment is Purchased and not part of any Pickup yet, so let's add it

            await this.addToPickup(fulfillment);
            result.status = 'added-to-pickup';
            carrierSound(fulfillment.customFields?.carrierCode, Tone.Synth);
        } catch (err: any) {
            errorSound();
            this.addFailure({ msg: `${barcode}: ${err?.message || err}`, type: 'danger' }, false);
        } finally {
            this.cd.markForCheck();
        }
    }

    undoScan(result: ScanResult) {
        this.dataService
            .mutate(UndoShippingLabelScanDocument, { fulfillmentId: result.fulfillment.id })
            .subscribe({
                next: () => {
                    result.status = 'undone';
                    this.notificationService.success(
                        `Fulfillment ${result.fulfillment.id} cleared and removed from pickup`,
                    );
                    delete this.processedBarcodes[result.barcode];
                },
                error: err => {
                    this.notificationService.error(`Failed to undo scan: ${err?.message || err}`);
                },
                complete: () => {
                    this.focusInput();
                    this.cd.markForCheck();
                },
            });
    }

    addFailure(failure: Failure, showNotification = true) {
        this.failures.push(failure);
        if (showNotification) {
            this.notificationService[failure.type]?.(failure.msg);
        }
        this.cd.markForCheck();
    }

    getFulfillment(barcode: string): Promise<Fulfillment> {
        return new Promise((resolve, reject) => {
            this.dataService
                .mutate(ShippingLabelScannedDocument, { barcode })
                .pipe(take(1))
                .subscribe({
                    next: res => {
                        if (res.shippingLabelScanned?.__typename === 'Fulfillment') {
                            resolve(res.shippingLabelScanned);
                        } else {
                            reject(res);
                        }
                    },
                    error: err => reject(err),
                    complete: () => this.cd.markForCheck(),
                });
        });
    }

    addToPickup(fulfillment: Fulfillment): Promise<Fulfillment> {
        return new Promise((resolve, reject) => {
            this.dataService
                .mutate(AssignFulfillmentsToPickupDocument, {
                    fulfillmentIds: [fulfillment.id],
                })
                .subscribe({
                    next: res => {
                        if (!res.assignFulfillmentsToPickup?.length) {
                            reject(res);
                            return;
                        }
                        for (const pickup of res.assignFulfillmentsToPickup) {
                            if (pickup.fulfillments.some(f => f.id === fulfillment.id)) {
                                fulfillment.easypostPickup = {
                                    id: pickup.id,
                                    carrier: pickup.carrier,
                                    state: pickup.state,
                                };
                                resolve(fulfillment);
                                return;
                            }
                        }
                        // shouldn't happen
                        reject(`Fulfillment ${fulfillment.id} not found in any pickup`);
                    },
                    error: err => reject(err),
                    complete: () => this.cd.markForCheck(),
                });
        });
    }

    carrierLogoUrl(fulfillment: Fulfillment) {
        const carrierCode = (fulfillment.customFields?.carrierCode || '').toLowerCase();
        const baseHref = document.baseURI;
        switch (true) {
            case carrierCode.startsWith('ups'):
                return `${baseHref}/assets/ups-logo.svg`;
            case carrierCode.startsWith('usps'):
                return `${baseHref}/assets/usps-logo.svg`;
            case carrierCode.startsWith('fedex'):
                return `${baseHref}/assets/fedex-logo.svg`;
            case carrierCode.startsWith('dhl'):
                return `${baseHref}/assets/dhl-logo.svg`;
            case carrierCode.startsWith('epostglobal'):
                return `${baseHref}/assets/epostglobal-logo.svg`;
            default:
                return '';
        }
    }
}
