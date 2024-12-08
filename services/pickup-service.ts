import { Injectable } from '@nestjs/common';
import { FindManyOptions, FindOneOptions, In } from 'typeorm';
import {
    ID,
    RequestContext,
    TransactionalConnection,
    EntityNotFoundError,
    IllegalOperationError,
    Logger,
    GlobalSettingsService,
    FulfillmentService,
    ChannelService,
    ConfigService,
    User,
    HistoryService,
} from '@vendure/core';

import { Pickup as PickupEntity } from '../entity/pickup.entity';
import { Fulfillment } from '@vendure/core';
import {
    BatchCreatedWebhookEvent,
    BatchUpdatedWebhookEvent,
    EasyPostWebhookEvent,
    getEasyPostClient,
    ScanFormCreatedWebhookEvent,
    ScanFormUpdatedWebhookEvent,
} from './easypost';
import { HistoryEntryListOptions, HistoryEntryType } from '../../codegen/generated-admin-types';
import { PickupHistoryEntryData } from '../extend/historyService-extend';

@Injectable()
export class PickupService {
    constructor(
        private connection: TransactionalConnection,
        private globalSettingsService: GlobalSettingsService,
        private fulfillmentService: FulfillmentService,
        private historyService: HistoryService,
        private channelService: ChannelService,
        private configService: ConfigService,
    ) {}

    private async getSuperadminContext() {
        const channel = await this.channelService.getDefaultChannel();
        const { superadminCredentials } = this.configService.authOptions;
        const superAdminUser = await this.connection.rawConnection.getRepository(User).findOneOrFail({
            where: { identifier: superadminCredentials.identifier },
        });

        return new RequestContext({
            channel: channel,
            apiType: 'admin',
            isAuthorized: true,
            authorizedAsOwnerOnly: false,
            session: {
                id: '',
                token: '',
                expires: new Date(),
                cacheExpiry: 999999,
                user: {
                    id: superAdminUser.id,
                    identifier: superAdminUser.identifier,
                    verified: true,
                    channelPermissions: [],
                },
            },
        });
    }

    getPickupRepository(ctx: RequestContext) {
        return this.connection.getRepository(ctx, PickupEntity);
    }

    async recordHistory<T extends keyof PickupHistoryEntryData>(
        ctx: RequestContext,
        pickupId: ID,
        type: T,
        data: PickupHistoryEntryData[T],
        isPublic = false,
    ) {
        return this.historyService.createHistoryEntryForPickup(
            {
                ctx,
                pickupId,
                type, // Convert from string to enum
                data,
            },
            isPublic,
        );
    }

    async findOne(
        ctx: RequestContext,
        options?: FindOneOptions<PickupEntity>,
    ): Promise<PickupEntity | undefined> {
        return this.getPickupRepository(ctx).findOne(options);
    }
    async findFulfillments(
        ctx: RequestContext,
        options: FindManyOptions<Fulfillment>,
    ): Promise<Fulfillment[]> {
        return this.connection.getRepository(ctx, Fulfillment).find(options);
    }

    async assignFulfillmentsToPickup(ctx: RequestContext, fulfillmentIds: ID[]): Promise<PickupEntity[]> {
        const fulfillments = await this.findFulfillments(ctx, {
            where: { id: In(fulfillmentIds) },
            relations: ['easypostPickup'],
        });

        // Group fulfillments by carrier
        const fulfillmentsByCarrier = new Map<string, Fulfillment[]>();
        for (const fulfillment of fulfillments) {
            if (!(fulfillment.customFields.shipmentId && fulfillment.customFields.ratePurchasedAt)) {
                throw new IllegalOperationError(
                    `Fulfillments must be purchased before they can be assigned to a pickup`,
                );
            }
            if (fulfillment.easypostPickup) {
                throw new IllegalOperationError(
                    `Fulfillment ${fulfillment.id} is already assigned to a pickup`,
                );
            }
            const carrier = this.getCarrierFromFulfillment(fulfillment);
            if (!fulfillmentsByCarrier.has(carrier)) {
                fulfillmentsByCarrier.set(carrier, []);
            }
            const carrierFulfillments = fulfillmentsByCarrier.get(carrier);
            if (!carrierFulfillments) {
                throw new Error('Cannot happen');
            }
            carrierFulfillments.push(fulfillment);
        }

        const results: PickupEntity[] = [];

        // For each carrier group, find or create a pickup
        for (const [carrier, carrierFulfillments] of fulfillmentsByCarrier) {
            // Try to find an existing open pickup for this carrier
            let pickup = await this.findOne(ctx, {
                where: {
                    carrier,
                    state: 'Open',
                },
                relations: ['fulfillments'],
            });

            // If no open pickup exists, create one
            if (!pickup) {
                pickup = new PickupEntity({
                    carrier,
                    state: 'Open',
                    fulfillments: [],
                });
            }

            // Add the fulfillments to the pickup
            pickup.fulfillments = [...pickup.fulfillments, ...carrierFulfillments];
            await this.getPickupRepository(ctx).save(pickup);
            await this.connection
                .getRepository(ctx, Fulfillment)
                .update(carrierFulfillments.map(f => f.id) as string[], { easypostPickup: pickup });

            results.push(pickup);
        }

        return results;
    }

    async removeFulfillmentsFromPickup(
        ctx: RequestContext,
        pickupId: ID,
        fulfillmentIds: ID[],
    ): Promise<PickupEntity> {
        const pickup = await this.findOne(ctx, {
            where: { id: pickupId },
            relations: ['fulfillments'],
        });

        if (!pickup) {
            throw new EntityNotFoundError('Pickup', pickupId);
        }

        if (pickup.state !== 'Open') {
            throw new IllegalOperationError('Cannot remove fulfillments from a Closed pickup');
        }

        // Remove the fulfillments from the pickup
        pickup.fulfillments = pickup.fulfillments.filter(f => !fulfillmentIds.includes(f.id));
        // There isn't a joining table, so we only need to save the fulfillments, not the pickup
        await this.connection
            .getRepository(ctx, Fulfillment)
            .update(fulfillmentIds as string[], { easypostPickup: null });

        return pickup;
    }

    async createScanForm(shipmentIds: string[]): Promise<{ scanFormId: string; batchId: string }> {
        // Attempt to create a scan form with the EasyPost API
        // This will automatically create a batch as well
        const epClient = getEasyPostClient();
        try {
            const scanForm = await epClient.ScanForm.create({
                shipments: shipmentIds,
            });
            if (scanForm) {
                return {
                    scanFormId: scanForm.id,
                    batchId: scanForm.batch_id,
                };
            }
        } catch (err) {
            Logger.error(`Failed to create scan form: ${err.message}`, 'PickupService');
            throw new Error(`Failed to create scan form: ${err.message}`);
        }
    }

    async createBatch(shipmentIds: string[]): Promise<{ batchId: string }> {
        // Attempt to create a batch with the EasyPost API
        const epClient = getEasyPostClient();
        try {
            const batch = await epClient.Batch.create({
                shipment: shipmentIds,
            });
            if (batch) {
                return {
                    batchId: batch.id,
                };
            }
        } catch (err) {
            Logger.error(`Failed to create batch: ${err.message}`, 'PickupService');
            throw new Error(`Failed to create batch: ${err.message}`);
        }
    }

    async closePickup(ctx: RequestContext, pickupId: ID): Promise<PickupEntity> {
        const pickup = await this.findOne(ctx, {
            where: { id: pickupId },
            relations: ['fulfillments'],
        });

        if (!pickup) {
            throw new EntityNotFoundError('Pickup', pickupId);
        }

        if (pickup.state !== 'Open') {
            throw new IllegalOperationError('Cannot close a pickup that is not Open');
        }

        // Transition all fulfillments to `Tendered`
        for (const fulfillment of pickup.fulfillments) {
            fulfillment.state = 'Tendered';
            await this.fulfillmentService.transitionToState(ctx, fulfillment.id, 'Tendered');
        }

        await this.recordHistory(ctx, pickupId, HistoryEntryType.PickupStateChangeEvent, {
            state: 'Closed',
            previousState: 'Open',
        });

        try {
            // Get all shipment IDs from the fulfillments
            const shipmentIds = pickup.fulfillments
                .filter(f => f.customFields.shipmentId)
                .map(f => f.customFields.shipmentId);

            if (shipmentIds.length === 0) {
                throw new Error('No valid shipments found in pickup');
            }

            try {
                const { scanFormId, batchId } = await this.createScanForm(shipmentIds);
                pickup.easyPostScanFormId = scanFormId;
                pickup.easyPostBatchId = batchId;

                await this.recordHistory(ctx, pickupId, HistoryEntryType.PickupScanFormEvent, {
                    eventName: 'Creating',
                    scanform_id: scanFormId,
                    batch_id: batchId,
                });
            } catch (err) {
                Logger.error(
                    `Failed to create scan form: ${err.message}. Falling back to creating a batch`,
                    'PickupService',
                );
                // Couldn't create scan form, so create a batch directly
                const { batchId } = await this.createBatch(shipmentIds);
                pickup.easyPostBatchId = batchId;

                await this.recordHistory(ctx, pickupId, HistoryEntryType.PickupBatchEvent, {
                    eventName: 'Creating',
                    batch_id: batchId,
                    message: 'Failed to create scan form: ' + err.message,
                });
            }

            // Update the pickup with the scan form info
            // The batch ID will come later via webhook
            pickup.state = 'Closed';

            return this.getPickupRepository(ctx).save(pickup);
        } catch (error) {
            Logger.error(`Failed to close pickup ${pickupId}: ${error.message}`, 'PickupService');
            throw new Error(`Failed to close pickup: ${error.message}`);
        }
    }

    async schedulePickup(
        ctx: RequestContext,
        pickupId: ID,
        pickupWindowStart: Date,
        pickupWindowEnd: Date,
    ): Promise<PickupEntity> {
        const pickup = await this.findOne(ctx, {
            where: { id: pickupId },
            relations: ['fulfillments'],
        });

        if (!pickup) {
            throw new EntityNotFoundError('Pickup', pickupId);
        }

        // If pickup is still Open, close it first
        if (pickup.state === 'Open') {
            await this.closePickup(ctx, pickupId);
        }

        try {
            const epClient = getEasyPostClient();

            // Get the first fulfillment to use its address
            const firstFulfillment = pickup.fulfillments[0];
            if (!firstFulfillment) {
                throw new Error('No fulfillments found in pickup');
            }

            const globalSettings = await this.globalSettingsService.getSettings(ctx);
            const pickupAddress =
                JSON.parse(globalSettings.customFields.easyPostPickupAddressJson || '') || {};

            // Create the EasyPost pickup
            const epPickup = await epClient.Pickup.create({
                address: { ...pickupAddress },
                batch: { id: pickup.easyPostBatchId },
                reference: `pickup_${pickup.id}`,
                min_datetime: pickupWindowStart.toISOString(),
                max_datetime: pickupWindowEnd.toISOString(),
                is_account_address: false,
                instructions: 'Please scan form provided',
            });

            // Get available rates
            const pickupRates = epPickup.pickup_rates || [];
            if (!pickupRates.length) {
                throw new Error('No pickup rates available');
            }

            // Choose the first available rate
            const rate = pickupRates[0];

            // Buy the pickup
            const purchasedPickup = await epClient.Pickup.buy(epPickup.id, rate.carrier, rate.service);

            const rateCents = parseFloat(rate.rate) * 100;

            await this.recordHistory(ctx, pickupId, HistoryEntryType.PickupScheduleEvent, {
                eventName: 'Scheduled',
                pickup_id: purchasedPickup.id,
                window_start: pickupWindowStart.toISOString(),
                window_end: pickupWindowEnd.toISOString(),
                cost: rateCents,
                message: purchasedPickup.messages?.join(', '),
            });

            // Update the pickup entity
            pickup.pickupWindowStart = pickupWindowStart;
            pickup.pickupWindowEnd = pickupWindowEnd;
            pickup.easyPostPickupId = purchasedPickup.id;
            pickup.pickupCost = rateCents; // Convert to cents

            return this.getPickupRepository(ctx).save(pickup);
        } catch (error) {
            Logger.error(`Failed to schedule pickup: ${error.message}`, 'PickupService');
            throw new Error(`Failed to schedule pickup: ${error.message}`);
        }
    }

    private getCarrierFromFulfillment(fulfillment: Fulfillment): string {
        return fulfillment.customFields.carrierCode;
    }

    async handleBatchHookEvent(
        ctx: RequestContext,
        hookEvent: BatchCreatedWebhookEvent | BatchUpdatedWebhookEvent,
    ) {
        if (hookEvent.status !== 'completed') {
            return;
        }
        const batchId = hookEvent.result.id;
        const pickup = await this.findOne(ctx, {
            where: { easyPostBatchId: batchId },
            relations: ['fulfillments'],
        });

        pickup.easyPostBatchId = batchId;
        await this.getPickupRepository(ctx).save(pickup);
    }

    async handleScanFormHookEvent(
        ctx: RequestContext,
        hookEvent: ScanFormCreatedWebhookEvent | ScanFormUpdatedWebhookEvent,
    ) {
        const scanFormId = hookEvent.result?.id;
        const pickup = await this.findOne(ctx, {
            where: { easyPostScanFormId: scanFormId },
            relations: ['fulfillments'],
        });

        if (!pickup) {
            Logger.error(`No pickup found with scan form ID ${scanFormId}`, 'PickupService');
            return;
        }

        if (hookEvent.status === 'failed') {
            Logger.error(`Failed to create scan form: ${hookEvent.result.message}`, 'PickupService');
            await this.recordHistory(ctx, hookEvent.result.id, HistoryEntryType.PickupScanFormEvent, {
                eventName: 'Failed',
                scanform_id: hookEvent.result.id,
                message: hookEvent.result.message,
            });
            return;
        }

        if (hookEvent.result.form_url) {
            pickup.scanFormUrl = hookEvent.result.form_url;
            pickup.easyPostBatchId = hookEvent.result.batch_id;
            await this.getPickupRepository(ctx).save(pickup);
            await this.recordHistory(ctx, pickup.id, HistoryEntryType.PickupScanFormEvent, {
                eventName: 'Created',
                scanform_id: scanFormId,
                batch_id: hookEvent.result.batch_id,
                form_url: hookEvent.result.form_url,
                message: hookEvent.result.message,
            });
        }
    }

    async handleWebhook(hookEvent: EasyPostWebhookEvent): Promise<boolean> {
        const ctx = await this.getSuperadminContext();

        let handled = true;
        switch (hookEvent.description) {
            case 'batch.created':
            case 'batch.updated':
                await this.handleBatchHookEvent(ctx, hookEvent);
                break;

            case 'scan_form.created':
            case 'scan_form.updated':
                await this.handleScanFormHookEvent(ctx, hookEvent);
                break;

            default:
                handled = false;
        }
        return handled;
    }
}
