import { DeepPartial } from '@vendure/common/lib/shared-types';
import { ChildEntity, Index, ManyToOne } from 'typeorm';

import { Fulfillment } from '@vendure/core';
import { HistoryEntry } from '@vendure/core/dist/entity/history-entry/history-entry.entity';

/**
 * @description
 * Represents an event in the history of a particular {@link Fulfillment}.
 *
 * @docsCategory entities
 */
@ChildEntity()
export class FulfillmentHistoryEntry extends HistoryEntry {
    constructor(input: DeepPartial<FulfillmentHistoryEntry>) {
        super(input);
    }

    @Index()
    @ManyToOne(type => Fulfillment, { onDelete: 'CASCADE' })
    fulfillment: Fulfillment;
}
