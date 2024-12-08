import gql from 'graphql-tag';

export const SHIPPABLE_ORDER_FRAGMENT = gql`
    fragment ShippableOrder on Order {
        id
        createdAt
        updatedAt
        type
        orderPlacedAt
        code
        state
        nextStates
        total
        totalWithTax
        currencyCode
        customer {
            id
            firstName
            lastName
        }
        shipping
        shippingLines {
            shippingMethod {
                name
                fulfillmentHandlerCode
            }
        }
        lines {
            id
            quantity
            productVariant {
                sku
            }
        }
        fulfillments {
            id
            state
            orders {
                id
            }
            lines {
                orderLineId
                quantity
            }
        }
    }
`;

export const GET_SHIPPABLE_ORDERS = gql`
    query GetShippableOrderList($options: ShippableOrderListOptions) {
        shippableOrders(options: $options) {
            items {
                ...ShippableOrder
                history(options: { filter: { type: { eq: "ORDER_NOTE" } } }) {
                    items {
                        createdAt
                        isPublic
                        administrator {
                            firstName
                            lastName
                        }
                        data
                    }
                }
                customFields {
                    customerNotes
                    fulfillmentNotes
                    deliveryInstructions
                    carrierCode
                    serviceCode
                }
            }
            totalItems
        }
    }
    ${SHIPPABLE_ORDER_FRAGMENT}
`;

export const GET_VARIANTS_WITH_STOCK = gql`
    query GetVariantBasicsWithStock($options: ProductVariantListOptions) {
        productVariants(options: $options) {
            items {
                id
                sku
                featuredAsset {
                    preview
                }
                product {
                    id
                    featuredAsset {
                        preview
                    }
                }
                stockLevels {
                    id
                    stockLocation {
                        id
                    }
                    stockOnHand
                    stockAllocated
                }
            }
            totalItems
        }
    }
`;
