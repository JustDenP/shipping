import { CustomFieldConfig, LanguageCode } from '@vendure/core';
import { CustomFieldsFrom } from '../../custom-fields';

declare module '@vendure/core/dist/entity/custom-entity-fields' {
    interface CustomFulfillmentFields extends CustomFieldsFrom<typeof fulfillmentFields> {} // eslint-disable-line @typescript-eslint/no-empty-interface
}

export const fulfillmentFields = [
    {
        name: 'invoiceId' as const,
        type: 'string' as const,
        label: [{ languageCode: LanguageCode.en_US, value: 'Invoice ID (#00006, #00006-1, etc)' }],
    },
    {
        name: 'treatAsManual' as const,
        type: 'boolean' as const,
        defaultValue: false,
        public: false,
        label: [{ languageCode: LanguageCode.en_US, value: 'Treat as Manual Fulfillment' }],
        description: [
            {
                languageCode: LanguageCode.en_US,
                value: `If true, this fulfillment will not go through the normal process of creating and purchasing a Shipment from EasyPost,
                        used for things like manual shipments, in-person pickups, etc. If you provide a value for 'trackingCode', we will still
                        purchase a Tracker from EasyPost to receive shipping updates like normal Shipments.`,
            },
        ],
    },
    {
        name: 'trackerId' as const,
        type: 'string' as const,
        public: true,
        label: [{ languageCode: LanguageCode.en_US, value: 'EasyPost Tracker ID' }],
    },
    {
        name: 'shipmentId' as const,
        type: 'string' as const,
        public: false,
        label: [{ languageCode: LanguageCode.en_US, value: 'EasyPost Shipment ID' }],
    },
    {
        name: 'labelScannedAt' as const,
        type: 'datetime' as const,
        public: false,
        label: [{ languageCode: LanguageCode.en_US, value: 'When we scanned the outbound shipping label' }],
    },
    {
        name: 'weight' as const,
        type: 'float' as const,
        public: false,
        label: [{ languageCode: LanguageCode.en_US, value: 'Shipping Weight (oz)' }],
    },
    {
        name: 'length' as const,
        type: 'float' as const,
        public: false,
        label: [{ languageCode: LanguageCode.en_US, value: 'Shipping Length (inches)' }],
    },
    {
        name: 'width' as const,
        type: 'float' as const,
        public: false,
        label: [{ languageCode: LanguageCode.en_US, value: 'Shipping Width (inches)' }],
    },
    {
        name: 'height' as const,
        type: 'float' as const,
        public: false,
        label: [{ languageCode: LanguageCode.en_US, value: 'Shipping Height (inches)' }],
    },
    {
        name: 'carrierId' as const,
        type: 'string' as const,
        public: false,
        label: [{ languageCode: LanguageCode.en_US, value: 'Carrier Account ID (ca_d9a8b2.....)' }],
    },
    {
        name: 'carrierCode' as const,
        type: 'string' as const,
        public: false,
        label: [{ languageCode: LanguageCode.en_US, value: 'Carrier Code (usps, fedex, etc)' }],
    },
    {
        name: 'serviceCode' as const,
        type: 'string' as const,
        public: false,
        label: [{ languageCode: LanguageCode.en_US, value: 'Service Code (priority, express, etc)' }],
    },
    {
        name: 'serviceName' as const,
        type: 'string' as const,
        label: [{ languageCode: LanguageCode.en_US, value: 'Service Name Used (e.g. FedEx Ground)' }],
    },
    {
        name: 'rateId' as const,
        type: 'string' as const,
        public: false,
        label: [{ languageCode: LanguageCode.en_US, value: 'EasyPost Rate ID' }],
    },
    {
        name: 'rateCost' as const,
        type: 'int' as const,
        public: false,
        label: [{ languageCode: LanguageCode.en_US, value: 'Carrier Rate Paid (final rate quote, cents)' }],
    },
    {
        name: 'insuranceCost' as const,
        type: 'int' as const,
        public: false,
        label: [{ languageCode: LanguageCode.en_US, value: 'Third-Party Insurance Paid (cents)' }],
    },
    {
        name: 'ratePurchasedAt' as const,
        type: 'datetime' as const,
        public: false,
        label: [{ languageCode: LanguageCode.en_US, value: 'When we initiated the purchase' }],
    },
    {
        name: 'labelUrl' as const,
        type: 'string' as const,
        public: false,
        label: [{ languageCode: LanguageCode.en_US, value: 'URL to download the Label source file (ZPL)' }],
    },
    {
        name: 'commInvoiceFiled' as const,
        type: 'boolean' as const,
        public: false,
        label: [{ languageCode: LanguageCode.en_US, value: 'Was commercial invoice filed electronically?' }],
    },
    {
        name: 'commInvoiceUrl' as const,
        type: 'string' as const,
        public: false,
        label: [{ languageCode: LanguageCode.en_US, value: 'URL to download the commercial invoice' }],
    },
] satisfies CustomFieldConfig[];
