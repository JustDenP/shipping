import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { Allow, Api, ApiType, Ctx, Fulfillment, HistoryService, ID, ListQueryBuilder, PaginatedList, RequestContext, Transaction } from '@vendure/core';
import { HistoryEntryListOptions, Permission, SortOrder } from '@vendure/common/lib/generated-types';

import { Pickup } from '../entity/pickup.entity';
import { PickupService } from '../services/pickup-service';
import { FulfillmentHistoryArgs } from 'src/plugins/codegen/generated-admin-types';

@Resolver('Pickup')
export class PickupAdminResolver {
    constructor(private pickupService: PickupService, private listQueryBuilder: ListQueryBuilder, private historyService: HistoryService) {}

    @Query()
    @Allow(Permission.ReadOrder)
    async pickups(@Ctx() ctx: RequestContext, @Args() args: any): Promise<PaginatedList<Pickup>> {
        return this.listQueryBuilder
            .build(Pickup, args.options || {}, {
                relations: ['fulfillments'],
                where: {},
            })
            .getManyAndCount()
            .then(([items, totalItems]) => ({
                items,
                totalItems,
            }));
    }

    @Query()
    @Allow(Permission.ReadOrder)
    async pickup(@Ctx() ctx: RequestContext, @Args() args: { id: ID }): Promise<Pickup | undefined> {
        return this.pickupService.findOne(ctx, {
            where: { id: args.id },
            relations: ['fulfillments', 'fulfillments.lines', 'fulfillments.orders'],
        });
    }

    @ResolveField()
    async history(
        @Ctx() ctx: RequestContext,
        @Api() apiType: ApiType,
        @Parent() pickup: Pickup,
        @Args() args: FulfillmentHistoryArgs,
    ) {
        const publicOnly = apiType === 'shop';
        const options: HistoryEntryListOptions = { ...args.options };
        if (!options.sort) {
            options.sort = { createdAt: SortOrder.ASC };
        }
        return this.historyService.getHistoryForOrder(ctx, pickup.id, publicOnly, options);
    }

    @Transaction()
    @Mutation()
    @Allow(Permission.UpdateOrder)
    async assignFulfillmentsToPickup(
        @Ctx() ctx: RequestContext,
        @Args() args: { fulfillmentIds: ID[] },
    ): Promise<Pickup[]> {
        return this.pickupService.assignFulfillmentsToPickup(ctx, args.fulfillmentIds);
    }

    @Transaction()
    @Mutation()
    @Allow(Permission.UpdateOrder)
    async removeFulfillmentsFromPickup(
        @Ctx() ctx: RequestContext,
        @Args() args: { id: ID; fulfillmentIds: ID[] },
    ): Promise<Pickup> {
        return this.pickupService.removeFulfillmentsFromPickup(ctx, args.id, args.fulfillmentIds);
    }

    @Transaction()
    @Mutation()
    @Allow(Permission.UpdateOrder)
    async closePickup(@Ctx() ctx: RequestContext, @Args() args: { id: ID }): Promise<Pickup> {
        return this.pickupService.closePickup(ctx, args.id);
    }

    @Transaction()
    @Mutation()
    @Allow(Permission.UpdateOrder)
    async schedulePickup(
        @Ctx() ctx: RequestContext,
        @Args() args: { id: ID; options: { pickupWindowStart: Date; pickupWindowEnd: Date } },
    ): Promise<Pickup> {
        return this.pickupService.schedulePickup(
            ctx,
            args.id,
            args.options.pickupWindowStart,
            args.options.pickupWindowEnd,
        );
    }
}
