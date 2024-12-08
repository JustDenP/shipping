import {
    RuntimeVendureConfig,
    HistoryService,
    HistoryEntryEvent,
    ID,
    RequestContext,
    PaginatedList,
    Type,
} from '@vendure/core';

import { HistoryEntryListOptions, HistoryEntryType } from '../../codegen/generated-admin-types';
import { IRefund, ITrackerStatus } from '@easypost/api';
import { ITrackerStatusDetail } from '@easypost/api/types/Tracker/TrackerStatusDetail';
import { FulfillmentHistoryEntry } from '../entity/FulfillmentHistoryEntry';
import { HistoryEntry } from '@vendure/core/dist/entity/history-entry/history-entry.entity';
import { PickupHistoryEntry } from '../entity/PickupHistoryEntry';

export interface FulfillmentHistoryEntryData {
    [HistoryEntryType.FulfillmentTrackingEvent]: {
        status: ITrackerStatus;
        detail: ITrackerStatusDetail;
        eta: string;
    };
    [HistoryEntryType.FulfillmentPurchasedEvent]: {
        rate_id: string;
        tracking_number: string;
        insurance: number;
        carrier: string;
        rate: number;
        label_uri?: string;
    };
    [HistoryEntryType.FulfillmentServiceChangeEvent]: {
        service: string;
        rate: number;
        old_service: string;
        old_rate: number;
    };
    [HistoryEntryType.FulfillmentRefundEvent]: {
        shipment_id: string;
        amount?: number;
        status: IRefund['status'];
    };
    [HistoryEntryType.FulfillmentShipmentCreatedEvent]: {
        shipment_id: string;
        rate_id: string;
        rate_cost: number;
        carrier: string;
        service: string;
        insuranceCost: number;
    };
}

// New interface for Pickup history data
export interface PickupHistoryEntryData {
    [HistoryEntryType.PickupStateChangeEvent]: {
        state: 'Open' | 'Closed';
        previousState?: 'Open' | 'Closed';
    };
    [HistoryEntryType.PickupBatchEvent]: {
        eventName: 'Creating' | 'Created' | 'Failed';
        batch_id: string;
        message?: string;
    };
    [HistoryEntryType.PickupScanFormEvent]: {
        eventName: 'Creating' | 'Created' | 'Failed';
        scanform_id: string;
        batch_id?: string;
        form_url?: string;
        message?: string;
    };
    [HistoryEntryType.PickupScheduleEvent]: {
        eventName: 'Scheduled' | 'Cancelled' | 'Failed';
        pickup_id?: string;
        confirmation?: string;
        window_start: string;
        window_end: string;
        cost?: number;
        message?: string;
    };
}


declare module '@vendure/core' {
    interface HistoryService {
        createHistoryEntryForFulfillment<T extends keyof FulfillmentHistoryEntryData>(
            args: CreateFulfillmentHistoryEntryArgs<T>,
            isPublic?: boolean,
        ): Promise<FulfillmentHistoryEntry>;

        updateFulfillmentHistoryEntry<T extends keyof FulfillmentHistoryEntryData>(
            ctx: RequestContext,
            args: UpdateFulfillmentHistoryEntryArgs<T>,
        ): Promise<FulfillmentHistoryEntry>;

        deleteFulfillmentHistoryEntry(ctx: RequestContext, id: ID): Promise<void>;

        getHistoryForFulfillment(
            ctx: RequestContext,
            fulfillmentId: ID,
            publicOnly: boolean,
            options?: HistoryEntryListOptions,
        ): Promise<PaginatedList<FulfillmentHistoryEntry>>;

        createHistoryEntryForPickup<T extends keyof PickupHistoryEntryData>(
            args: CreatePickupHistoryEntryArgs<T>,
            isPublic?: boolean,
        ): Promise<PickupHistoryEntry>;

        updatePickupHistoryEntry<T extends keyof PickupHistoryEntryData>(
            ctx: RequestContext,
            args: UpdatePickupHistoryEntryArgs<T>,
        ): Promise<PickupHistoryEntry>;

        deletePickupHistoryEntry(ctx: RequestContext, id: ID): Promise<void>;

        getHistoryForPickup(
            ctx: RequestContext,
            pickupId: ID,
            publicOnly: boolean,
            options?: HistoryEntryListOptions,
        ): Promise<PaginatedList<PickupHistoryEntry>>;
    }
}

export interface CreateFulfillmentHistoryEntryArgs<T extends keyof FulfillmentHistoryEntryData> {
    fulfillmentId: ID;
    ctx: RequestContext;
    type: T;
    data: FulfillmentHistoryEntryData[T];
}
export interface UpdateFulfillmentHistoryEntryArgs<T extends keyof FulfillmentHistoryEntryData> {
    entryId: ID;
    ctx: RequestContext;
    type: T;
    isPublic?: boolean;
    data?: FulfillmentHistoryEntryData[T];
}
export interface CreatePickupHistoryEntryArgs<T extends keyof PickupHistoryEntryData> {
    pickupId: ID;
    ctx: RequestContext;
    type: T;
    data: PickupHistoryEntryData[T];
}

export interface UpdatePickupHistoryEntryArgs<T extends keyof PickupHistoryEntryData> {
    entryId: ID;
    ctx: RequestContext;
    type: T;
    isPublic?: boolean;
    data?: PickupHistoryEntryData[T];
}

function augmentServiceObject(proto: HistoryService) {
    proto.createHistoryEntryForFulfillment = async function createHistoryEntryForFulfillment<
        T extends keyof FulfillmentHistoryEntryData,
    >(args: CreateFulfillmentHistoryEntryArgs<T>, isPublic = false): Promise<FulfillmentHistoryEntry> {
        const { ctx, data, fulfillmentId, type } = args;
        const administrator = await this.getAdministratorFromContext(ctx);
        const entry = new FulfillmentHistoryEntry({
            createdAt: new Date(),
            type: type as any,
            isPublic,
            data: data as any,
            fulfillment: { id: fulfillmentId },
            administrator,
        });
        const history = await this.connection.getRepository(ctx, FulfillmentHistoryEntry).save(entry);
        await this.eventBus.publish(
            new HistoryEntryEvent(ctx, history, 'created', 'fulfillment', { type: type as any, data }),
        );
        return history;
    };

    proto.updateFulfillmentHistoryEntry = async function updateFulfillmentHistoryEntry<
        T extends keyof FulfillmentHistoryEntryData,
    >(ctx: RequestContext, args: UpdateFulfillmentHistoryEntryArgs<T>): Promise<FulfillmentHistoryEntry> {
        const entry = await this.connection.getEntityOrThrow(ctx, FulfillmentHistoryEntry, args.entryId, {
            where: { type: args.type },
        });

        if (args.data) {
            entry.data = args.data;
        }
        if (typeof args.isPublic === 'boolean') {
            entry.isPublic = args.isPublic;
        }
        const administrator = await this.getAdministratorFromContext(ctx);
        if (administrator) {
            entry.administrator = administrator;
        }
        const newEntry = await this.connection.getRepository(ctx, FulfillmentHistoryEntry).save(entry);
        await this.eventBus.publish(new HistoryEntryEvent(ctx, entry, 'updated', 'fulfillment', args as any));
        return newEntry;
    };

    proto.deleteFulfillmentHistoryEntry = async function deleteFulfillmentHistoryEntry(
        ctx: RequestContext,
        id: ID,
    ): Promise<void> {
        const entry = await this.connection.getEntityOrThrow(ctx, FulfillmentHistoryEntry, id);
        const deletedEntry = new FulfillmentHistoryEntry(entry);
        await this.connection.getRepository(ctx, FulfillmentHistoryEntry).remove(entry);
        await this.eventBus.publish(new HistoryEntryEvent(ctx, deletedEntry, 'deleted', 'customer', id));
    };

    proto.getHistoryForFulfillment = async function getHistoryForCustomer(
        ctx: RequestContext,
        fulfillmentId: ID,
        publicOnly: boolean,
        options?: HistoryEntryListOptions,
    ): Promise<PaginatedList<FulfillmentHistoryEntry>> {
        return this.listQueryBuilder
            .build(HistoryEntry as any as Type<FulfillmentHistoryEntry>, options, {
                where: {
                    fulfillment: { id: fulfillmentId } as any,
                    ...(publicOnly ? { isPublic: true } : {}),
                },
                relations: ['administrator'],
                ctx,
            })
            .getManyAndCount()
            .then(([items, totalItems]) => ({
                items,
                totalItems,
            }));
    };

    proto.createHistoryEntryForPickup = async function createHistoryEntryForPickup<
        T extends keyof PickupHistoryEntryData,
    >(args: CreatePickupHistoryEntryArgs<T>, isPublic = false): Promise<PickupHistoryEntry> {
        const { ctx, data, pickupId, type } = args;
        const administrator = await this.getAdministratorFromContext(ctx);
        const entry = new PickupHistoryEntry({
            createdAt: new Date(),
            type: type as any,
            isPublic,
            data: data as any,
            pickup: { id: pickupId },
            administrator,
        });
        const history = await this.connection.getRepository(ctx, PickupHistoryEntry).save(entry);
        await this.eventBus.publish(
            new HistoryEntryEvent(ctx, history, 'created', 'pickup', { type: type as any, data }),
        );
        return history;
    };

    proto.updatePickupHistoryEntry = async function updatePickupHistoryEntry<
        T extends keyof PickupHistoryEntryData,
    >(ctx: RequestContext, args: UpdatePickupHistoryEntryArgs<T>): Promise<PickupHistoryEntry> {
        const entry = await this.connection.getEntityOrThrow(ctx, PickupHistoryEntry, args.entryId, {
            where: { type: args.type },
        });

        if (args.data) {
            entry.data = args.data;
        }
        if (typeof args.isPublic === 'boolean') {
            entry.isPublic = args.isPublic;
        }
        const administrator = await this.getAdministratorFromContext(ctx);
        if (administrator) {
            entry.administrator = administrator;
        }
        const newEntry = await this.connection.getRepository(ctx, PickupHistoryEntry).save(entry);
        await this.eventBus.publish(new HistoryEntryEvent(ctx, entry, 'updated', 'pickup', args as any));
        return newEntry;
    };

    proto.deletePickupHistoryEntry = async function deletePickupHistoryEntry(
        ctx: RequestContext,
        id: ID,
    ): Promise<void> {
        const entry = await this.connection.getEntityOrThrow(ctx, PickupHistoryEntry, id);
        const deletedEntry = new PickupHistoryEntry(entry);
        await this.connection.getRepository(ctx, PickupHistoryEntry).remove(entry);
        await this.eventBus.publish(new HistoryEntryEvent(ctx, deletedEntry, 'deleted', 'pickup', id));
    };

    proto.getHistoryForPickup = async function getHistoryForPickup(
        ctx: RequestContext,
        pickupId: ID,
        publicOnly: boolean,
        options?: HistoryEntryListOptions,
    ): Promise<PaginatedList<PickupHistoryEntry>> {
        return this.listQueryBuilder
            .build(HistoryEntry as any as Type<PickupHistoryEntry>, options, {
                where: {
                    pickup: { id: pickupId } as any,
                    ...(publicOnly ? { isPublic: true } : {}),
                },
                relations: ['administrator'],
                ctx,
            })
            .getManyAndCount()
            .then(([items, totalItems]) => ({
                items,
                totalItems,
            }));
    };
}

export function extendHistoryService(config: RuntimeVendureConfig): RuntimeVendureConfig {
    augmentServiceObject(HistoryService.prototype);
    return config;
}
