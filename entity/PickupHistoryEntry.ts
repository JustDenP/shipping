import { DeepPartial } from '@vendure/common/lib/shared-types';
import { ChildEntity, Index, ManyToOne } from 'typeorm';

import { HistoryEntry } from '@vendure/core/dist/entity/history-entry/history-entry.entity';
import { Pickup } from './pickup.entity';

/**
 * @description
 * Represents an event in the history of a particular {@link Pickup}.
 *
 * @docsCategory entities
 */
@ChildEntity()
export class PickupHistoryEntry extends HistoryEntry {
    constructor(input: DeepPartial<PickupHistoryEntry>) {
        super(input);
    }

    @Index()
    @ManyToOne(type => Pickup, { onDelete: 'CASCADE' })
    pickup: Pickup;
}