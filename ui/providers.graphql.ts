import { gql } from 'graphql-tag';

export const CORRECT_ORDER_STATES = gql`
    mutation CorrectOrderStates($orderIds: [ID!]!) {
        correctOrderStates(orderIds: $orderIds) {
            orderId
            changed
            errorMessage
        }
    }
`;

export const ENSURE_PENDING_FULFILLMENT = gql`
    mutation EnsurePendingFulfillment($orderIds: [ID]!) {
        ensurePendingFulfillment(orderIds: $orderIds) {
            id
            state
            orders {
                id
                code
            }
            customFields {
                shipmentId
                rateCost
                insuranceCost
            }
        }
    }
`;
