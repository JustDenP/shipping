import { Parent, Resolver, ResolveField } from '@nestjs/graphql';
import { Asset, AssetService, Ctx, OrderLine, RequestContext, TransactionalConnection } from '@vendure/core';

@Resolver('OrderLine')
export class EasyPostAdminOrderLineResolver {
    constructor(private connection: TransactionalConnection, private assetService: AssetService) {}

    @ResolveField()
    async featuredAsset(
        @Ctx() ctx: RequestContext,
        @Parent() orderLine: OrderLine,
    ): Promise<Asset | undefined> {
        if (orderLine.featuredAsset !== undefined) {
            // In some scenarios (e.g. modifying an order to add a new item), orderLine.featuredAsset is an object
            // with only an `id`, but the rest of the resolver expects the full Asset available so it can e.g.
            // use the preview field. So, let's grab the whole thing if we have to.
            if (!orderLine.featuredAsset.preview) {
                const asset = await this.connection.findOneInChannel(
                    ctx,
                    Asset,
                    orderLine.featuredAsset.id,
                    ctx.channelId,
                );
                return asset;
            }
            return orderLine.featuredAsset;
        } else {
            const featuredAsset = await this.assetService.getFeaturedAsset(ctx, orderLine);
            return featuredAsset;
        }
    }
}
