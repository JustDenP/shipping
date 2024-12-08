import { ChangeDetectionStrategy, ChangeDetectorRef, Component, Injector, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { DataService, NotificationService, PageMetadataService } from '@vendure/admin-ui/core';
import {
    ClosePickupDocument,
    GetPickupDocument,
    GetPickupQuery,
    GetPickupQueryVariables,
    RemoveFulfillmentsDocument,
    SchedulePickupDocument,
} from '../../generated-types';
import dayjs from 'dayjs';

type PickupObj = GetPickupQuery['pickup'];
@Component({
    selector: 'ep-pickup-detail',
    templateUrl: './pickup-detail.component.html',
    styleUrls: ['./pickup-detail.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PickupDetailComponent implements OnInit {
    pickupId = '';
    pickup: PickupObj;
    selectedItems = new Map<string, boolean>();
    now = dayjs().endOf('hour').toISOString();
    oneWeek = dayjs().add(7, 'day').endOf('day').toISOString();
    pickupWindowStart: Date;
    pickupWindowEnd: Date;

    constructor(
        private route: ActivatedRoute,
        private dataService: DataService,
        private injector: Injector,
        private cd: ChangeDetectorRef,
        private notificationService: NotificationService,
        private pageMetadataService: PageMetadataService,
    ) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        this.pickupId = this.route.snapshot.paramMap.get('id')!;
    }

    ngOnInit(): void {
        this.getPickup();
    }

    countItems(fulfillment: any): number {
        return fulfillment.lines.reduce((total: number, line: any) => total + line.quantity, 0);
    }

    areAllSelected() {
        return this.selectedItems.size && this.selectedItems.size === this.pickup?.fulfillments.length;
    }
    hasAnySelected() {
        return this.selectedItems.size > 0;
    }
    toggleSelect(id: string) {
        if (!this.pickup) return;
        if (this.selectedItems.get(id)) {
            this.selectedItems.delete(id);
        } else {
            this.selectedItems.set(id, true);
        }
        this.cd.markForCheck();
    }
    toggleSelectAll(forceState?: boolean) {
        if (!this.pickup) return;
        if (this.areAllSelected() || forceState === false) {
            this.selectedItems.clear();
        } else if (!this.areAllSelected() || forceState === true) {
            this.pickup.fulfillments.forEach(f => {
                this.selectedItems.set(f.id, true);
            });
        }
        this.cd.markForCheck();
    }

    removeSelected() {
        if (!this.pickup || !this.hasAnySelected()) return;
        this.dataService
            .mutate(RemoveFulfillmentsDocument, {
                id: this.pickup.id,
                fulfillmentIds: [...this.selectedItems.keys()],
            })
            .subscribe({
                next: data => {
                    if (data.removeFulfillmentsFromPickup.__typename === 'Pickup') {
                        this.notificationService.success('Fulfillments removed');
                        this.toggleSelectAll(false);
                        this.getPickup();
                    }
                },
            });
    }

    closePickup() {
        if (!this.pickup) return;
        this.dataService
            .mutate(ClosePickupDocument, {
                id: this.pickup.id,
            })
            .subscribe({
                next: data => {
                    if (data.closePickup.__typename === 'Pickup') {
                        this.notificationService.success('Success');
                        this.getPickup();
                    }
                },
            });
    }

    schedulePickup() {
        if (
            this.pickup?.state !== 'Closed' ||
            !this.pickup.fulfillments.length ||
            !this.pickupWindowStart ||
            !this.pickupWindowEnd
        ) {
            return;
        }
        return this.dataService
            .mutate(SchedulePickupDocument, {
                id: this.pickup.id,
                options: {
                    pickupWindowStart: this.pickupWindowStart,
                    pickupWindowEnd: this.pickupWindowEnd,
                },
            })
            .subscribe({
                next: data => {
                    if (data.schedulePickup.__typename === 'Pickup') {
                        this.notificationService.success('Pickup scheduled');
                        this.getPickup();
                    }
                },
            });
    }

    getPickup() {
        return this.dataService
            .query<GetPickupQuery, GetPickupQueryVariables>(GetPickupDocument, {
                id: this.pickupId,
            })
            .single$.subscribe({
                next: data => {
                    if (data) {
                        this.pickup = data.pickup;
                        this.cd.markForCheck();
                        // this.pageMetadataService.setTitle(this.pickup!.id);
                    } else {
                        console.warn('No data returned for pickup ID:', this.pickupId);
                    }
                },
                error: error => {
                    console.error('Error fetching pickup detail:', error);
                    this.notificationService.error('Error fetching pickup details'); // Display notification on error
                },
                complete: () => {
                    console.log('Pickup detail fetching complete');
                },
            });
    }
}
