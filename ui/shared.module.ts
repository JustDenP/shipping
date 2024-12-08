import { NgModule } from '@angular/core';
import { SharedModule } from '@vendure/admin-ui/core';
import { FulfillmentHistoryEntryComponent } from './components/fulfillment-history-entry.component';
import { CommonModule } from '@angular/common';

@NgModule({
    imports: [SharedModule, CommonModule],
    providers: [],
    declarations: [FulfillmentHistoryEntryComponent],
})
export class OrderShipmentExtensionModule {}
