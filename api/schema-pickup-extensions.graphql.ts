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

export const PickupAdminApiExtension = gql`
    enum PickupState {
        Open
        Closed
    }

    type Pickup implements Node {
        id: ID!
        createdAt: DateTime!
        updatedAt: DateTime!
        state: PickupState!
        carrier: String!
        pickupWindowStart: DateTime
        pickupWindowEnd: DateTime
        pickupCost: Money
        scanFormUrl: String
        easyPostBatchId: String
        easyPostPickupId: String
        easyPostScanFormId: String
        fulfillments: [Fulfillment!]!
        history(options: HistoryEntryListOptions): HistoryEntryList!
    }

    type PickupList implements PaginatedList {
        items: [Pickup!]!
        totalItems: Int!
    }

    input PickupFilterParameter {
        id: IDOperators
        createdAt: DateOperators
        updatedAt: DateOperators
        state: StringOperators
        carrier: StringOperators
    }

    input PickupListOptions {
        skip: Int
        take: Int
        sort: PickupSortParameter
        filter: PickupFilterParameter
    }

    input PickupSortParameter {
        id: SortOrder
        createdAt: SortOrder
        updatedAt: SortOrder
        carrier: SortOrder
    }

    input SchedulePickupInput {
        pickupWindowStart: DateTime!
        pickupWindowEnd: DateTime!
    }

    extend type Query {
        "Get a paginated list of all pickups"
        pickups(options: PickupListOptions): PickupList!

        "Get a pickup by id"
        pickup(id: ID!): Pickup
    }

    extend type Mutation {
        "Assign fulfillments to pickups, creating new pickups per carrier if needed"
        assignFulfillmentsToPickup(fulfillmentIds: [ID!]!): [Pickup!]!

        "Remove fulfillments from a pickup"
        removeFulfillmentsFromPickup(id: ID!, fulfillmentIds: [ID!]!): Pickup!

        "Close a pickup and generate EasyPost batch and scan form"
        closePickup(id: ID!): Pickup!

        "Schedule a pickup with the carrier"
        schedulePickup(id: ID!, options: SchedulePickupInput!): Pickup!
    }

    ${PICKUP_LIST_FIELDS_FRAGMENT}
`;
