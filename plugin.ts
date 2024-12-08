import {
    CustomFieldConfig,
    EventBus,
    EntityHydrator,
    FulfillmentService,
    FulfillmentState,
    LanguageCode,
    Order,
    PluginCommonModule,
    registerPluginStartupMessage,
    TransactionalConnection,
    VendurePlugin,
    RequestContext,
} from '@vendure/core';
import { AdminUiExtension } from '@vendure/ui-devkit/compiler';
import path from 'path';
import { gql } from 'graphql-tag';

import * as express from 'express';

import {  } from '@vendure/core';
import { EasyPostAdminApiExtension, EasyPostShopApiExtension } from './api/schema-extensions.graphql';
import { EasyPostFulfillmentService } from './services/fulfillment-service';
import { PdfWriterService } from './services/pdf-writer-service';
import { EasyPostShopResolver } from './api/shop-resolver';
// import { AdminUiExtension } from '@vendure/ui-devkit/compiler';
// import path from 'path'
// import HttpModule from "@nestjs/axios"
import { OnApplicationBootstrap, MiddlewareConsumer } from '@nestjs/common';
import { RedisOptions } from 'ioredis';
import { setEasyPostApiKey, validateEasypostWebhook } from './services/easypost';
import { easyPostEligibilityChecker } from './calculator/eligibility-checker';
import { EasyPostAdminFulfillmentResolver } from './api/admin-fulfillment.resolver';
import { easyPostShippingCalculator } from './calculator/calculator';
import { easyPostFulfillmentHandler } from './fulfillment-handler';
import { fulfillmentFields } from './custom-fields';

import { rawBodyMiddleware, RequestWithRawBody } from './middleware';
import { OrderLineInput } from '../codegen/generated-admin-types';
import { PdfController } from './controller/pdf-controller';
import { EasyPostAdminOrderLineResolver } from './api/admin-order-line.resolver';
import { PickupAdminApiExtension } from './api/schema-pickup-extensions.graphql';
import { PickupAdminResolver } from './api/admin-pickup.resolver';
import { PickupService } from './services/pickup-service';
import { CustomFieldsFrom } from 'src/custom-fields';
import { linkFulfillment, Pickup } from './entity/pickup.entity';
import { FulfillmentHistoryEntry } from './entity/FulfillmentHistoryEntry';
import { extendHistoryService } from './extend/historyService-extend';
import { PickupHistoryEntry } from './entity/PickupHistoryEntry';
import { easyPostFulfillmentProcess } from './easypost.fulfillment-process';
import { easyPostOrderProcess } from './easypost.order-process';

function makeHookPath(prefix: string, path: string) {
    return `/` + [prefix, path].filter(Boolean).join('/');
}

declare module '@vendure/core/dist/entity/custom-entity-fields' {
    // eslint-disable-next-line @typescript-eslint/no-empty-interface
    interface CustomGlobalSettingsFields
        extends CustomFieldsFrom<typeof easyPostGlobalSettingsCustomFields> {}
}

const DEFAULT_REDIS_NAMESPACE = 'easypost-cache';

const easyPostGlobalSettingsCustomFields = [
    {
        name: 'insuranceValueMin' as const,
        type: 'float',
        label: [{ languageCode: LanguageCode.en, value: 'Insure shipments with a value over ...' }],
        defaultValue: 150.0,
    },
    {
        name: 'insureValuePercent' as const,
        type: 'int',
        label: [{ languageCode: LanguageCode.en, value: 'When buying insurance, cover __% of item value' }],
        defaultValue: 50,
        min: 0,
        max: 100,
    },
    {
        name: 'easyPostPickupAddressJson' as const,
        type: 'text',
        label: [{ languageCode: LanguageCode.en, value: 'EasyPost Pickup Address (simple JSON)' }],
    },
] satisfies CustomFieldConfig[];

export interface CalculateShippingTaxArgs {
    order: Order;
    shippingAmount: number;
    ctx: RequestContext;
}
export interface ShippingTaxCalculationStrategy {
    calculateShippingTax(args: CalculateShippingTaxArgs): Promise<number>;
}

export interface EasyPostPluginConfig {
    redisOptions?: RedisOptions;
    redisNamespace?: string;
    cacheExpireSeconds?: number;
    easyPostAPIKey?: string;
    webhookSecret?: string;
    webhookPrefix?: string;
    webhookUri?: string;
    logoFilePath?: string;
    thanksFooterPath?: string;
    shippingTaxStrategy?: ShippingTaxCalculationStrategy;
}

/**
 * From what states can a fulfillment be automatically cancelled as the result of
 * e.g. an order transitioning to Modifying or Cancelled? Basically, any state that
 * isn't purchased and not already cancelled. (Cancelling / refunding a purchased
 * label is a separate manual process.)
 */
export const AutoCancellableFulfillmentStates: FulfillmentState[] = ['Created', 'Pending', 'OnHold'];
@VendurePlugin({
    imports: [PluginCommonModule],
    entities: [Pickup, FulfillmentHistoryEntry, PickupHistoryEntry],
    adminApiExtensions: {
        resolvers: [EasyPostAdminFulfillmentResolver, EasyPostAdminOrderLineResolver, PickupAdminResolver],
        schema: gql`
            ${EasyPostAdminApiExtension}
            ${PickupAdminApiExtension}

            extend enum HistoryEntryType {
                FulfillmentTrackingEvent
                FulfillmentRefundEvent
                FulfillmentPurchasedEvent
                FulfillmentServiceChangeEvent
                FulfillmentShipmentCreatedEvent

                PickupStateChangeEvent
                PickupBatchEvent
                PickupScanFormEvent
                PickupScheduleEvent
            }
        `,
    },
    controllers: [PdfController],
    shopApiExtensions: {
        resolvers: [EasyPostShopResolver],
        schema: EasyPostShopApiExtension,
    },
    compatibility: '>0.0.0',
    providers: [EasyPostFulfillmentService, PdfWriterService, PickupService],
    configuration: config => {
        config.shippingOptions.fulfillmentHandlers.push(easyPostFulfillmentHandler);
        config.shippingOptions.shippingCalculators.push(easyPostShippingCalculator);
        config.shippingOptions.shippingEligibilityCheckers.push(easyPostEligibilityChecker);
        config.shippingOptions.process = [easyPostFulfillmentProcess];
        config.orderOptions.process.push(easyPostOrderProcess);
        config.customFields.Fulfillment.push(...fulfillmentFields);

        const hookPath = makeHookPath(EasyPostPlugin.config.webhookPrefix, 'easypost');
        config.apiOptions.middleware.push({
            route: hookPath,
            handler: rawBodyMiddleware,
            beforeListen: true,
        });

        config.entityOptions.metadataModifiers.push(linkFulfillment);

        config.customFields.GlobalSettings.push(...easyPostGlobalSettingsCustomFields);

        return extendHistoryService(config);
    },
})
export class EasyPostPlugin implements OnApplicationBootstrap {
    static config: EasyPostPluginConfig;

    constructor(
        private eventBus: EventBus,
        private easyPostService: EasyPostFulfillmentService,
        private pickupService: PickupService,
        private fulfillmentService: FulfillmentService,
        private connection: TransactionalConnection,
        private hydrator: EntityHydrator,
    ) {
        if (EasyPostPlugin.config.shippingTaxStrategy) {
            easyPostService.setShippingTaxStrategy(EasyPostPlugin.config.shippingTaxStrategy);
        }
    }

    /**
     * Initialize the plugin with configuration options
     */
    static init(config: Partial<EasyPostPluginConfig>) {
        this.config = {
            redisNamespace: DEFAULT_REDIS_NAMESPACE,
            cacheExpireSeconds: 60 * 60 * 2, // Cache for 2 hours by default
            webhookPrefix: 'v-hook',
            ...config,
        };
        if (config.easyPostAPIKey) {
            setEasyPostApiKey(config.easyPostAPIKey);
        }
        if (config.logoFilePath) {
            PdfWriterService.setLogoFiles(config.logoFilePath, config.thanksFooterPath).catch(err => {
                console.error('Error reading logo file:', err);
            });
        }
        return this;
    }

    get webhookPath() {
        return makeHookPath(EasyPostPlugin.config.webhookPrefix, 'easypost');
    }

    configure(consumer: MiddlewareConsumer) {
        const hookPath = this.webhookPath;
        consumer.apply(this.createWebhookServer()).forRoutes(EasyPostPlugin.config.webhookPrefix);
        registerPluginStartupMessage('EasyPost Plugin', hookPath.slice(1));
        registerPluginStartupMessage('EasyPost PDF', 'v-pdf-api');
    }

    private createWebhookServer() {
        const webhookServer = express.Router();
        webhookServer.post('/easypost', async (req: RequestWithRawBody, res, next) => {
            try {
                const check = validateEasypostWebhook(
                    req.rawBody,
                    req.headers,
                    EasyPostPlugin.config.webhookSecret,
                );

                const checkAll = await Promise.allSettled([
                    this.easyPostService.handleWebhook(check),
                    this.pickupService.handleWebhook(check),
                ]);
                const oneSucceeded = checkAll.some(result => result.status === 'fulfilled' && result.value);
                if (!oneSucceeded) {
                    console.log(
                        'Unhandled Webhook received:',
                        check.description,
                        JSON.stringify(check, null, 2),
                    );
                }
                res.status(200).send({ message: 'Webhook received' });
            } catch (err) {
                console.error(err);
                next(err);
            }
        });
        return webhookServer;
    }

    /**
     * Setup required services when the application boots up
     */
    async onApplicationBootstrap() {
        this.easyPostService.initializeCache(EasyPostPlugin.config);

        // If we have a webhook URI configured, make sure it's registered with EasyPost
        if (EasyPostPlugin.config.webhookUri && EasyPostPlugin.config.webhookSecret != '0') {
            try {
                await this.easyPostService.registerEasypostWebhook(
                    `${EasyPostPlugin.config.webhookUri}/easypost`,
                    EasyPostPlugin.config.webhookSecret,
                );
            } catch (error) {
                console.error('Failed to register EasyPost webhook:', error);
            }
        }
    }

    static ui: AdminUiExtension = {
        id: 'easy-post-ui',
        extensionPath: path.join(__dirname, 'ui'),
        routes: [{ route: 'easy-post', filePath: 'routes.ts' }],
        staticAssets: [
            { path: path.join(__dirname, 'ui/static-assets/dhl-logo.svg'), rename: 'dhl-logo.svg' },
            {
                path: path.join(__dirname, 'ui/static-assets/epostglobal-logo.svg'),
                rename: 'epostglobal-logo.svg',
            },
            { path: path.join(__dirname, 'ui/static-assets/fedex-logo.svg'), rename: 'fedex-logo.svg' },
            { path: path.join(__dirname, 'ui/static-assets/ups-logo.svg'), rename: 'ups-logo.svg' },
            { path: path.join(__dirname, 'ui/static-assets/usps-logo.svg'), rename: 'usps-logo.svg' },
        ],
        providers: ['providers.ts'],
        ngModules: [
            {
                type: 'lazy',
                route: 'sales',
                ngModuleFileName: 'lazy.module.ts',
                ngModuleName: 'ShipmentUIModule',
            },
            {
                type: 'shared',
                ngModuleFileName: 'shared.module.ts',
                ngModuleName: 'OrderShipmentExtensionModule',
            },
        ],
    };
}
