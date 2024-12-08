import EasyPostClient, {
    DeepPartial,
    IAddress,
    IBatch,
    IInsurance,
    ITracker,
    IScanForm,
    IReport,
    IRefund,
    IMessage,
    IOptions,
    IParcel,
    IRate,
    IShipment,
} from '@easypost/api';

let EASYPOST_API_KEY = process.env.EASYPOST_API_KEY || '';

export function setEasyPostApiKey(apiKey: string) {
    EASYPOST_API_KEY = apiKey;
}

let easyPostClient: EasyPostClient;
export function getEasyPostClient() {
    if (!easyPostClient) {
        easyPostClient = new EasyPostClient(EASYPOST_API_KEY);
    }
    return easyPostClient;
}

export type EasyPostShipmentDef = DeepPartial<IShipment> & { carrier_accounts?: string[]; service?: string };
export interface BetaRateShipmentResponse {
    from_address: IAddress;
    to_address: IAddress;
    rates: IRate[];
    options: IOptions;
    parcel: IParcel;
    messages: IMessage[];
}

export async function retrieveStatelessRates(shipmentDetails: EasyPostShipmentDef): Promise<IRate[]> {
    try {
        const client = getEasyPostClient() as any; // These types aren't defined :-(

        const rates = await client.BetaRate.retrieveStatelessRates(shipmentDetails);

        return rates?.rates || rates;
    } catch (e) {
        console.log(e);
    }
}

export function validateEasypostWebhook(
    body: Buffer,
    headers: Record<string, string | string[]>,
    secret: string,
) {
    const epClient = getEasyPostClient();
    const obj = epClient.Utils.validateWebhook(body, headers, secret);

    return obj as EasyPostWebhookEvent;
}

// Common Event Type (Shared properties for all events)
export interface BaseEvent {
    object: 'Event';
    id: string; // Unique identifier, begins with "evt_"
    mode: 'test' | 'production';
    status: 'completed' | 'failed' | 'in_queue' | 'retrying';
    pending_urls: string[]; // URLs yet to be notified
    completed_urls: string[]; // URLs already notified
    created_at: string; // ISO 8601 date-time string
    updated_at: string; // ISO 8601 date-time string
    previous_attributes?: Record<string, any>; // Previous values of relevant attributes
}

// Specific Event Types (Assuming existing types for results)
export interface BatchCreatedWebhookEvent extends BaseEvent {
    description: 'batch.created';
    result: IBatch;
}

export interface BatchUpdatedWebhookEvent extends BaseEvent {
    description: 'batch.updated';
    result: IBatch;
}

export interface InsurancePurchasedWebhookEvent extends BaseEvent {
    description: 'insurance.purchased';
    result: IInsurance;
}

export interface InsuranceCancelledWebhookEvent extends BaseEvent {
    description: 'insurance.cancelled';
    result: IInsurance;
}

export interface PaymentCreatedWebhookEvent extends BaseEvent {
    description: 'payment.created';
    result: unknown;
}

export interface PaymentCompletedWebhookEvent extends BaseEvent {
    description: 'payment.completed';
    result: unknown;
}

export interface PaymentFailedWebhookEvent extends BaseEvent {
    description: 'payment.failed';
    result: unknown;
}

export interface RefundSuccessfulWebhookEvent extends BaseEvent {
    description: 'refund.successful';
    result: IRefund;
}

export interface ReportNewWebhookEvent extends BaseEvent {
    description: 'report.new';
    result: IReport;
}

export interface ReportEmptyWebhookEvent extends BaseEvent {
    description: 'report.empty';
    result: IReport;
}

export interface ReportAvailableWebhookEvent extends BaseEvent {
    description: 'report.available';
    result: IReport;
}

export interface ReportFailedWebhookEvent extends BaseEvent {
    description: 'report.failed';
    result: IReport;
}

export interface ScanFormCreatedWebhookEvent extends BaseEvent {
    description: 'scan_form.created';
    result: IScanForm;
}

export interface ScanFormUpdatedWebhookEvent extends BaseEvent {
    description: 'scan_form.updated';
    result: IScanForm;
}

//   interface ShipmentInvoiceCreatedWebhookEvent extends BaseEvent {
//     description: 'shipment.invoice.created';
//     result: IShipmentInvoice;
//   }

//   interface ShipmentInvoiceUpdatedWebhookEvent extends BaseEvent {
//     description: 'shipment.invoice.updated';
//     result: ShipmentInvoice;
//   }

export interface TrackerCreatedWebhookEvent extends BaseEvent {
    description: 'tracker.created';
    result: ITracker;
}

export interface TrackerUpdatedWebhookEvent extends BaseEvent {
    description: 'tracker.updated';
    result: ITracker;
}

// Union Type (Discriminated by the 'description' field)
export type EasyPostWebhookEvent =
    | BatchCreatedWebhookEvent
    | BatchUpdatedWebhookEvent
    | InsurancePurchasedWebhookEvent
    | InsuranceCancelledWebhookEvent
    | PaymentCreatedWebhookEvent
    | PaymentCompletedWebhookEvent
    | PaymentFailedWebhookEvent
    | RefundSuccessfulWebhookEvent
    | ReportNewWebhookEvent
    | ReportEmptyWebhookEvent
    | ReportAvailableWebhookEvent
    | ReportFailedWebhookEvent
    | ScanFormCreatedWebhookEvent
    | ScanFormUpdatedWebhookEvent
    // | ShipmentInvoiceCreatedWebhookEvent
    // | ShipmentInvoiceUpdatedWebhookEvent
    | TrackerCreatedWebhookEvent
    | TrackerUpdatedWebhookEvent;
