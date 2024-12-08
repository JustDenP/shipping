import gql from 'graphql-tag';

export const GET_SHIPMENT_DETAIL = gql`
    query GetFulfillment($id: ID!) {
        fulfillment(id: $id) {
            id
            createdAt
            updatedAt
            state
            trackingCode
            method
            orders {
                id
                code
                currencyCode
                shippingWithTax
                shippingAddress {
                    fullName
                    streetLine1
                    streetLine2
                    city
                    province
                    postalCode
                    phoneNumber
                    country
                    countryCode
                }
                customer {
                    id
                    firstName
                    lastName
                }
            }
            lines {
                orderLine {
                    id
                    quantity
                    linePrice
                    linePriceWithTax
                    discountedLinePrice
                    discountedLinePriceWithTax
                    unitPrice
                    unitPriceWithTax
                    discountedUnitPrice
                    discountedUnitPriceWithTax
                    discounts {
                        type
                        description
                        amount
                    }
                    productVariant {
                        id
                        name
                        sku
                        featuredAsset {
                            id
                            preview
                        }
                        product {
                            id
                            name
                            featuredAsset {
                                id
                                preview
                            }
                        }
                        name
                    }
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
                commInvoiceFiled
                commInvoiceUrl
                serviceCode
                serviceName
                shipmentId
                trackerId
                rateCost
                ratePurchasedAt
                labelScannedAt
            }
        }
    }

    mutation RemoveFromPickup($id: ID!, $fulfillmentIds: [ID!]!) {
        removeFulfillmentsFromPickup(id: $id, fulfillmentIds: $fulfillmentIds) {
            id
            state
            carrier
        }
    }
`;
