import gql from 'graphql-tag';

export const PICKUP_LIST_FIELDS_FRAGMENT = gql`
    # Reusable fragment for pickup fields
    fragment PickupFields on Pickup {
        id
        state
        carrier
        pickupWindowStart
        pickupWindowEnd
        pickupCost
        scanFormUrl
    }
`;

export const GET_SHIPMENT_DETAIL = gql`
    query GetPickup($id: ID!) {
        pickup(id: $id) {
            ...PickupDetail
        }
    }

    mutation RemoveFulfillments($id: ID!, $fulfillmentIds: [ID!]!) {
        removeFulfillmentsFromPickup(id: $id, fulfillmentIds: $fulfillmentIds) {
            id
            state
        }
    }

    mutation closePickup($id: ID!) {
        closePickup(id: $id) {
            id
            state
        }
    }

    mutation schedulePickup($id: ID!, $options: SchedulePickupInput!) {
        schedulePickup(id: $id, options: $options) {
            id
            state
            easyPostPickupId
            pickupWindowStart
            pickupWindowEnd
        }
    }

    fragment PickupDetail on Pickup {
        ...PickupFields
        easyPostBatchId
        easyPostPickupId
        easyPostScanFormId
        fulfillments {
            id
            trackingCode
            orders {
                shippingAddress {
                    city
                    province
                    country
                    countryCode
                }
            }
            lines {
                quantity
            }
            customFields {
                invoiceId
                serviceName
            }
        }
    }

    ${PICKUP_LIST_FIELDS_FRAGMENT}
`;
