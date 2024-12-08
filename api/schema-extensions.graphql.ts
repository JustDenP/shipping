import gql from 'graphql-tag';

const EasyPostTypes = gql`
    type ShippingRates {
        id: String
        serviceName: String!
        serviceCode: String!
        shipmentCost: Float!
        otherCost: Float! # how much to collect for insurance on this shipment
        currency: String!
        carrierDeliveryDate: String
        carrierDeliveryGuarantee: Boolean
    }

    type CarrierWithRates {
        id: String!
        name: String!
        code: String!
        nickname: String!
        primary: Boolean
        services: [ShippingRates!]!
    }
    input MutationSetOrderShippingFieldsInput {
        orderID: ID!
        carrierId: String!
        carrierCode: String!
        serviceCode: String!
        serviceName: String!
    }
`;

export const EasyPostShopApiExtension = gql`
    extend type Query {
        orderAllAvailableRates: [CarrierWithRates!]!
    }

    extend type Mutation {
        setOrderShippingFields(input: MutationSetOrderShippingFieldsInput!): Order!
    }

    ${EasyPostTypes}
`;

export const EasyPostAdminApiExtension = gql`
    type MessageResponse {
        status: String!
        message: String!
    }
    type ResponseMessage {
        status: String!
        message: String!
        errors: [String!]
    }
    type OrderStateCheckResult {
        orderId: ID!
        changed: Boolean!
        errorMessage: String
    }

    extend type Query {
        # orderShippingRates(orderID: ID!): [ShippingRates!]!

        shippableOrders(options: ShippableOrderListOptions): ShippableOrderList!

        fulfillments(options: FulfillmentListOptions): FulfillmentList!
        fulfillment(id: ID!): Fulfillment
        fulfillmentAvailableShippingRates(id: ID!): [CarrierWithRates!]!
        unfulfilledOrderRates(orderId: ID!): [CarrierWithRates!]
    }
    extend type Mutation {
        clearEasypostCache: Boolean!
        updateFulfillmentShippingDetails(id: ID!, input: UpdateFulfillmentShippingDetailsInput!): Fulfillment!
        combineFulfillments(fulfillmentIds: [ID!]!): Fulfillment!
        ensurePendingFulfillment(orderIds: [ID]!): Fulfillment!
        shippingLabelScanned(barcode: String!): Fulfillment!
        undoShippingLabelScan(fulfillmentId: ID!): Fulfillment!

        correctOrderStates(orderIds: [ID!]!): [OrderStateCheckResult!]!

        transitionFulfillmentToStateWithCustomFields(
            input: UpdateFulfillmentInput!
            state: String!
        ): TransitionFulfillmentToStateResult!

        # refundShipment(shipmentId: [String!]!): ResponseMessage!
    }

    type ShippableOrderList implements PaginatedList {
        items: [Order!]!
        totalItems: Int!
    }

    input UpdateFulfillmentInput {
        id: ID!
        method: String
        trackingCode: String
    }

    input UpdateFulfillmentShippingDetailsInput {
        weight: Float
        length: Float
        width: Float
        height: Float
        carrierId: String
        carrierCode: String
        serviceCode: String
        serviceName: String
        rateId: String
        rateCost: Int # cents, including insurance cost (otherCost)
    }

    extend type Fulfillment {
        orders: [Order!]!
        easypostPickup: Pickup
        history(options: HistoryEntryListOptions): HistoryEntryList!
    }

    input FulfillmentListOptions {
        skip: Int
        take: Int
        sort: FulfillmentSortParameter
        filter: FulfillmentFilterParameter
    }

    input FulfillmentSortParameter {
        id: SortOrder
        createdAt: SortOrder
        updatedAt: SortOrder
        orderCode: SortOrder
        customerLastName: SortOrder
        method: SortOrder
        state: SortOrder
    }

    input FulfillmentFilterParameter {
        id: IDOperators
        createdAt: DateOperators
        updatedAt: DateOperators
        orderCode: SortOrder
        customerLastName: SortOrder
        customerEmail: SortOrder
        productVariantSku: StringOperators
        method: StringOperators
        state: StringOperators
        pickupState: StringOperators
    }

    input ShippableOrderListOptions {
        # Skips the first n results, for use in pagination
        skip: Int

        # Takes n results, for use in pagination
        take: Int

        # Specifies which properties to sort the results by
        sort: ShippableOrderSortParameter

        # Allows the results to be filtered
        filter: ShippableOrderFilterParameter

        # Specifies whether multiple top-level "filter" fields should be combined with a logical AND or OR operation. Defaults to AND.
        filterOperator: LogicalOperator
    }

    input ShippableOrderFilterParameter {
        customerEmail: StringOperators
        customerLastName: StringOperators
        transactionId: StringOperators
        aggregateOrderId: IDOperators
        id: IDOperators
        createdAt: DateOperators
        updatedAt: DateOperators
        type: StringOperators
        orderPlacedAt: DateOperators
        code: StringOperators
        state: StringOperators
        active: BooleanOperators
        totalQuantity: NumberOperators
        subTotal: NumberOperators
        subTotalWithTax: NumberOperators
        currencyCode: StringOperators
        shipping: NumberOperators
        shippingWithTax: NumberOperators
        total: NumberOperators
        totalWithTax: NumberOperators
        _and: [ShippableOrderFilterParameter!]
        _or: [ShippableOrderFilterParameter!]
        customerNotes: StringOperators
        isGift: BooleanOperators
        giftMessage: StringOperators
        targetRadio: StringListOperators
        carrierCode: StringOperators
        carrierId: StringOperators
        serviceCode: StringOperators
        serviceName: StringOperators
        shipmentId: StringOperators
        replacementParentOrderCode: StringOperators
        replacementReason: StringOperators
        taxCloudOrderId: StringOperators
        affiliateCode: StringOperators
        affiliateCommission: NumberOperators
        affiliateStatus: BooleanOperators
    }

    input ShippableOrderSortParameter {
        customerLastName: SortOrder
        transactionId: SortOrder
        aggregateOrderId: SortOrder
        id: SortOrder
        createdAt: SortOrder
        updatedAt: SortOrder
        orderPlacedAt: SortOrder
        code: SortOrder
        state: SortOrder
        totalQuantity: SortOrder
        subTotal: SortOrder
        subTotalWithTax: SortOrder
        shipping: SortOrder
        shippingWithTax: SortOrder
        total: SortOrder
        totalWithTax: SortOrder
        customerNotes: SortOrder
        isGift: SortOrder
        giftMessage: SortOrder
        carrierCode: SortOrder
        carrierId: SortOrder
        serviceCode: SortOrder
        serviceName: SortOrder
        shipmentId: SortOrder
        replacementParentOrderCode: SortOrder
        replacementReason: SortOrder
        taxCloudOrderId: SortOrder
        affiliateCode: SortOrder
        affiliateCommission: SortOrder
        affiliateStatus: SortOrder
    }

    type FulfillmentList implements PaginatedList {
        items: [Fulfillment!]!
        totalItems: Int!
    }

    ${EasyPostTypes}
    extend type ShippingRates {
        insuranceCost: Float! # how much we will pay to a third party to insure this shipment
    }
`;
