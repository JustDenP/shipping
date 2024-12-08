import { gql } from 'graphql-tag';
import { PICKUP_LIST_FIELDS_FRAGMENT } from '../pickup-detail/pickup-detail.graphql';

export const GET_FULFILLMENTS = gql`
    query GetPickups($options: PickupListOptions) {
        pickups(options: $options) {
            items {
                ...PickupFields
                fulfillments {
                    id
                    trackingCode
                }
            }
            totalItems
        }
    }

    ${PICKUP_LIST_FIELDS_FRAGMENT}
`;
