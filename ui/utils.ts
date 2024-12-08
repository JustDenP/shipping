import { Injector } from '@angular/core';
import { DataService, ModalService } from '@vendure/admin-ui/core';
import { SelectShippingRateDialogComponent } from './components/select-shipping-rate-dialog/select-shipping-rate-dialog.component';
import { filter, switchMap } from 'rxjs/operators';
import {
    UpdateFulfillmentShippingDetailsDocument,
    UpdateFulfillmentShippingDetailsMutation,
} from './generated-types';
import { Observable } from 'rxjs';

export function openPickListInNewWindow(ids: string[]) {
    window.open(`/v-admin-api/pdf-api/picklist/${ids.join(',')}`, '_blank');
}

export function openLabelsInNewWindow(ids: string[]) {
    window.open(`/v-admin-api/pdf-api/packing/${ids.join(',')}`, '_blank');
}

export function openSelectShippingRateDialog(
    injector: Injector,
    fulfillmentId: string,
): Observable<UpdateFulfillmentShippingDetailsMutation> {
    const modalService = injector.get(ModalService);
    const dataService = injector.get(DataService);
    return modalService
        .fromComponent(SelectShippingRateDialogComponent, {
            locals: {
                fulfillmentId,
            },
        })
        .pipe(
            filter(result => !!result),
            switchMap(result => {
                result = result!; // TS doesn't know we've filtered
                return dataService.mutate(UpdateFulfillmentShippingDetailsDocument, {
                    id: fulfillmentId,
                    input: {
                        carrierCode: result.code,
                        carrierId: result.id,
                        serviceCode: result.service.serviceCode,
                        serviceName: result.service.serviceName,
                        rateId: result.service.id || '',
                        rateCost: Math.round((result.service.shipmentCost + result.service.otherCost / 2) * 100),
                    },
                });
            }),
        );
}

export function formatDate(dateString: string): string {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);
    const diffDays = diffMs / (1000 * 60 * 60 * 24);

    const timeOptions = { hour: 'numeric' as const, minute: '2-digit' as const, hour12: true };

    const isSameWeekday = now.getDay() === date.getDay();

    if (diffHours < 24 && isSameWeekday) {
        // If within the last 24 hours, return just the time
        return date.toLocaleTimeString([], timeOptions);
    } else if (diffDays < 7 && !isSameWeekday) {
        // If within the last week and not the same weekday, return day + time
        const weekdayOptions = { weekday: 'short' as const, ...timeOptions };
        return date.toLocaleDateString([], weekdayOptions);
    } else {
        // If it's the same weekday or older, return the full date
        const longOptions = {
            month: 'short' as const,
            day: 'numeric' as const,
            year: 'numeric' as const,
            ...timeOptions,
        };
        return date.toLocaleDateString([], longOptions);
    }
}
