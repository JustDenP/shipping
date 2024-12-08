import { DeepPartial } from '@vendure/common/lib/shared-types';
import { Column, Entity, OneToMany, ManyToOne } from 'typeorm';
import { VendureEntity, Money, Fulfillment, EntityMetadataModifier } from '@vendure/core';

// Add pickup link to Fulfillment entity
export const linkFulfillment: EntityMetadataModifier = metadata => {
    const instance = new Fulfillment();
    ManyToOne(
        type => Pickup,
        pickup => pickup.fulfillments,
        { onDelete: 'SET NULL' },
    )(instance, 'easypostPickup');
};

declare module '@vendure/core' {
    interface Fulfillment {
        easypostPickup: Pickup;
    }
}

/**
 * @description
 * Represents a scheduled pickup request through EasyPost. A Pickup is associated with one or more
 * {@link Fulfillment}s which will be collected during the pickup.
 *
 * @docsCategory entities
 */
@Entity()
export class Pickup extends VendureEntity {
    constructor(input?: DeepPartial<Pickup>) {
        super(input);
    }

    @Column('varchar')
    state: 'Open' | 'Closed';

    @Column()
    carrier: string;

    @Column({ type: Date, nullable: true })
    pickupWindowStart: Date | null;

    @Column({ type: Date, nullable: true })
    pickupWindowEnd: Date | null;

    @Money({ nullable: true })
    pickupCost: number | null;

    /**
     * @description
     * The unique identifier assigned by EasyPost when the batch is created
     */
    @Column({ nullable: true })
    easyPostBatchId: string | null;

    /**
     * @description
     * The unique identifier assigned by EasyPost when the pickup is created
     */
    @Column({ nullable: true })
    easyPostPickupId: string | null;

    /**
     * @description
     * The unique identifier assigned by EasyPost when the ScanForm is created
     */
    @Column({ nullable: true })
    easyPostScanFormId: string | null;

    @Column({ nullable: true })
    scanFormUrl: string;

    @OneToMany(type => Fulfillment, fulfillment => fulfillment.easypostPickup)
    fulfillments: Fulfillment[];
}
