/* eslint-disable @typescript-eslint/no-unused-vars */
import { Injector, LanguageCode, Logger, ShippingCalculator } from '@vendure/core';
import { EasyPostFulfillmentService } from '../services/fulfillment-service';

let easyPostService: EasyPostFulfillmentService;

function ifNaN(value: number, def = 0): number {
    return isNaN(value) ? def : value;
}

export const easyPostShippingCalculator = new ShippingCalculator({
    code: 'easypost-shipping-calculator',
    description: [
        {
            languageCode: LanguageCode.en,
            value: 'Calculate Cost based on EasyPost',
        },
    ],
    args: {},
    async init(injector: Injector) {
        easyPostService = injector.get(EasyPostFulfillmentService);
    },
    calculate: async (ctx, order, args) => {
        try {
            // const variants = order.lines.map(line => line.productVariant);

            const carrierCode = order?.customFields?.carrierCode;
            const serviceCode = order?.customFields?.serviceCode;
            const serviceName = order?.customFields?.serviceName;

            const orderShippingRate = await easyPostService.getOrderShippingRate(
                ctx,
                order,
                carrierCode,
                serviceCode,
            );

            const taxAmount = await easyPostService.lookupSalesTaxForShipping(ctx, order, orderShippingRate);

            console.log(
                `EasyPost Shipping Calculator:: Tax Amount: ${taxAmount}, Shipping Rate: ${orderShippingRate}`,
            );
            return {
                price: orderShippingRate,
                priceIncludesTax: false,
                taxRate: ifNaN((taxAmount / orderShippingRate) * 100, 0),
                metadata: { serviceName, serviceCode, carrierCode },
            };
        } catch (err: any) {
            console.error(`EasyPost Shipping Calculator:: ${err}`);
            // Instead of failing to do anything, log the error and return 0
            Logger.error(err.message);
            return {
                price: 0,
                priceIncludesTax: ctx.channel.pricesIncludeTax,
                taxRate: 0,
                metadata: { error: err.message },
            };
        }
    },
});
