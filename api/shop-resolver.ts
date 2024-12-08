/* eslint-disable prettier/prettier */
import { Resolver, Query, Args, Mutation } from "@nestjs/graphql";
import {
  Ctx,
  RequestContext,
  OrderService,
  UserInputError,
  ActiveOrderService,
  Relations,
  Order,
  RelationPaths,
  Allow,
  Permission,
} from "@vendure/core";
import { EasyPostFulfillmentService } from "../services/fulfillment-service";
import { CarrierWithRates, MutationSetOrderShippingFieldsInput } from "../../codegen/generated-shop-types";

@Resolver()
export class EasyPostShopResolver {
  constructor(
    private easyPostService: EasyPostFulfillmentService,
    private orderService: OrderService,
    private activeOrderService: ActiveOrderService
  ) {}

  // @Query()
  // @Allow(Permission.Owner)
  // async shippingRates(@Ctx() ctx: RequestContext, @Args() args: QueryShippingRatesArgs) {
  //     return this.EasyPostService.getShippingRates(ctx, args);
  // }

  @Query()
  @Allow(Permission.Owner)
  async orderAllAvailableRates(
    @Ctx() ctx: RequestContext
  ): Promise<CarrierWithRates[]> {
    const activeOrder = await this.activeOrderService.getActiveOrder(ctx, {});
    if (!activeOrder) {
      throw new UserInputError("No active order found");
    }
    // const activeOrder = await this.orderService.getActiveOrderForUser(ctx, ctx.activeUserId);
    const order = await this.orderService.findOne(ctx, activeOrder.id, [
      "lines",
      "lines.productVariant",
      "lines.productVariant.product",
      "lines.taxCategory",
    ]);
    if (!order) {
      throw new Error("order not found");
    }

    const rates = await this.easyPostService.getShippingRates(ctx, order);
    if (!rates) {
      throw new Error("rates not found");
    }
    return rates;
  }

  @Mutation()
  async setOrderShippingFields(
    @Ctx() ctx: RequestContext,
    @Relations(Order) relations: RelationPaths<Order>,
    @Args() args: MutationSetOrderShippingFieldsInput
  ) {
    if (!ctx.session || !ctx.activeUserId) {
      throw new UserInputError("No any active session or active user found");
    }
    const activeOrder = await this.activeOrderService.getActiveOrder(ctx, {});
    if (!activeOrder) {
      throw new UserInputError("No any active order found");
    }
    const order = await this.orderService.findOne(ctx, activeOrder.id, [
      "lines",
      "lines.productVariant",
      "lines.taxCategory",
    ]);
    if (!order) {
      throw new UserInputError("No order with given id found");
    }
    if (!order.shippingAddress?.postalCode || !order.shippingAddress?.city) {
      throw new UserInputError(
        "Please provide proper postal code and shipping city"
      );
    }
    if (order.state == "Delivered") {
      throw new UserInputError("The order is already delivered");
    }
    const updatedOrder = await this.orderService.updateCustomFields(
      ctx,
      order.id,
      {
        carrierId: args.carrierId,
        carrierCode: args.carrierCode,
        serviceCode: args.serviceCode,
        serviceName: args.serviceName,
      }
    );
    return updatedOrder;
  }
}
