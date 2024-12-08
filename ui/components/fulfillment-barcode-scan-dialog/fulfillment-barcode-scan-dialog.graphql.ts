import { gql } from 'graphql-tag';

export const BARCODE_SCAN = gql`
    mutation ShippingLabelScanned($barcode: String!) {
        shippingLabelScanned(barcode: $barcode) {
            ...FulfillmentFragment
        }
    }

    mutation UndoShippingLabelScan($fulfillmentId: ID!) {
        undoShippingLabelScan(fulfillmentId: $fulfillmentId) {
            ...FulfillmentFragment
        }
    }

    fragment FulfillmentFragment on Fulfillment {
        id
        state
        trackingCode
        orders {
            id
            code
            customer {
                id
                firstName
                lastName
            }
        }
        customFields {
            carrierCode
            serviceName
            labelScannedAt
        }
        easypostPickup {
            id
            state
            carrier
        }
    }
`;
