import { gql } from 'graphql-tag';

export const GET_FULFILLMENTS = gql`
    query GetFulfillments($options: FulfillmentListOptions) {
        fulfillments(options: $options) {
            items {
                id
                createdAt
                updatedAt
                state
                trackingCode
                method
                lines {
                    quantity
                    orderLine {
                        productVariant {
                            sku
                            featuredAsset {
                                preview
                            }
                            product {
                                featuredAsset {
                                    preview
                                }
                            }
                        }
                    }
                }
                orders {
                    id
                    code
                    shipping
                    shippingAddress {
                        city
                        province
                        country
                        countryCode
                    }
                    customer {
                        id
                        firstName
                        lastName
                    }
                }
                easypostPickup {
                    id
                    state
                    carrier
                }
                customFields {
                    invoiceId
                    weight
                    length
                    width
                    height
                    carrierId
                    carrierCode
                    serviceCode
                    serviceName
                    shipmentId
                    rateCost
                    ratePurchasedAt
                }
            }
            totalItems
        }
    }

    mutation combineFulfillments($fulfillmentIds: [ID!]!) {
        combineFulfillments(fulfillmentIds: $fulfillmentIds) {
            id
            state
        }
    }

    mutation assignFulfillmentsToPickup($fulfillmentIds: [ID!]!) {
        assignFulfillmentsToPickup(fulfillmentIds: $fulfillmentIds) {
            id
            state
            carrier
            pickupWindowStart
            pickupWindowEnd
            pickupCost
            scanFormUrl
            fulfillments {
                id
                trackingCode
            }
        }
    }
`;
