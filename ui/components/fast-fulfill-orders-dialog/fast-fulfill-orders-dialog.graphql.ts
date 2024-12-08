import { gql } from 'graphql-tag';

export const FAST_FULFILL_ORDERS = gql`
    mutation TransitionFulfillmentWithCustomFields($input: UpdateFulfillmentInput!, $state: String!) {
        transitionFulfillmentToStateWithCustomFields(input: $input, state: $state) {
            ...FulfillmentPurchaseSummary
            ... on FulfillmentStateTransitionError {
                transitionError
            }
        }
    }

    fragment FulfillmentPurchaseSummary on Fulfillment {
        id
        state
        customFields {
            shipmentId
            rateCost
            ratePurchasedAt
            commInvoiceUrl
        }
    }
`;
