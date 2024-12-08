import { gql } from 'apollo-angular';

export const GET_FULFILLMENT_AVAILABLE_SHIPPING_RATES = gql`
    query GetFulfillmentAvailableShippingRates($id: ID!) {
        fulfillmentAvailableShippingRates(id: $id) {
            id
            name
            code
            nickname
            primary
            services {
                id
                serviceCode
                serviceName
                shipmentCost
                otherCost
                insuranceCost
                currency
                carrierDeliveryDate
                carrierDeliveryGuarantee
            }
        }
    }

    query GetUnfilledOrderAvailableShippingRates($orderId: ID!) {
        unfulfilledOrderRates(orderId: $orderId) {
            id
            name
            code
            nickname
            primary
            services {
                id
                serviceCode
                serviceName
                shipmentCost
                otherCost
                insuranceCost
                currency
                carrierDeliveryDate
                carrierDeliveryGuarantee
            }
        }
    }

    mutation UpdateFulfillmentShippingDetails($id: ID!, $input: UpdateFulfillmentShippingDetailsInput!) {
        updateFulfillmentShippingDetails(id: $id, input: $input) {
            id
            state
            customFields {
                carrierId
                carrierCode
                serviceCode
                serviceName
                rateCost
            }
        }
    }
`;
