/* eslint-disable @typescript-eslint/ban-ts-comment */
import { IAddress, ICustomsItem, IParcel } from '@easypost/api';
import { Fulfillment, LanguageCode, Order, OrderLine, ProductVariant } from '@vendure/core';
import { OrderAddress, OrderLineInput } from '../../codegen/generated-admin-types';
import { EasyPostShipmentDef } from './easypost';
import { compareStrings } from '../../../../src/lib/string';

declare module '@vendure/core/dist/entity/custom-entity-fields' {
    interface CustomCustomerFields {
        callsign?: string;
    }
}

export function isValidShippingAddress(address: Order['shippingAddress']): boolean {
    if (!address) return false;
    return !!(address.streetLine1 && address.city && address.postalCode && address.country);
}

/**
 * Creates an EasyPost Shipment object representing this fulfillment.
 * Fulfillment should have orders and lines.orderLines hydrated.
 */
export function fulfillmentToEasyPostShipment(fulfillment: Fulfillment): EasyPostShipmentDef {
    const { weight, height, width, length } = fulfillment.customFields;
    // dimensions are expected to be set before we get here
    if (!(weight && height && width && length)) {
        throw new Error('Weight, height, width, and length are required to create a shipment');
    }

    // for now, assume the first order is the one we're shipping to (almost all shipments are single order)
    const def = constructEasyPostShipmentDef(
        fulfillment.orders[0],
        fulfillment.lines.map(l => l.orderLine),
        {
            weight,
            height,
            width,
            length,
        },
        true,
    );
    def.options.invoice_number = fulfillment.customFields.invoiceId;
    return def;
}

/**
 * Takes an Order and converts it into an EasyPost shipment definition.
 * Used to calculate shipping costs for an order during checkout, not for
 * actually shipping the order.
 */
export function orderToEasyPostShipment(
    order: Pick<Order, 'lines' | 'shippingAddress' | 'customer'>,
): EasyPostShipmentDef {
    const dims = improvedCalculateOrderShipDimensions(order);
    return constructEasyPostShipmentDef(order, order.lines, {
        weight: dims.weightInOunces,
        height: dims.heightInInches,
        width: dims.widthInInches,
        length: dims.lengthInInches,
    });
}

export function getEasyPostOriginAddress(): Partial<IAddress> {
    return {
        company: process.env.SHIP_FROM_COMPANY || '',
        street1: process.env.SHIP_FROM_STREET || '',
        city: process.env.SHIP_FROM_CITY || '',
        state: process.env.SHIP_FROM_STATE || '',
        zip: process.env.SHIP_FROM_POSTAL_CODE || '',
        country: process.env.SHIP_FROM_COUNTRY_CODE || '',
        phone: process.env.SHIP_FROM_PHONE || '',
        email: process.env.SHIP_FROM_EMAIL || '',
    };
}

export function toEasyPostAddress(address: OrderAddress, email?: string): Partial<IAddress> {
    return {
        street1: address.streetLine1 || '',
        company: address.company || '',
        street2: address.streetLine2 || '',
        city: address.city || '',
        state: address.province || '',
        zip: address.postalCode || '',
        country: address.country || '',
        name: address.fullName || 'Unknown',
        phone: address.phoneNumber || '',
        ...(email ? { email } : {}),
    };
}

const getEnTranslation = (variant: ProductVariant) =>
    variant.translations.find(t => t.languageCode === LanguageCode.en);

export function constructEasyPostShipmentDef(
    order: Pick<Order, 'shippingAddress' | 'customer'>, // used for shipping address
    lines: OrderLine[],
    dims: Pick<IParcel, 'weight' | 'height' | 'width' | 'length'>,
    enforceExportValue = false,
): EasyPostShipmentDef {
    if (lines.some(line => !line.productVariant?.product)) {
        throw new Error('ProductVariant or Product not populated for OrderLine');
    }

    let totalValue = 0; // if this gets over 2500, we're gonna have problems (ship in multiple batches prolly)
    const customs_items = lines
        .filter(line => line.quantity > 0)
        .map(line => {
            // For value and weight, EasyPost wants the total for "all the items of that type in the package" (not per item)
            const value = line.discountedLinePrice / 100;
            totalValue += value;
            const weight = (line.productVariant.customFields.shipping_weight || 0.1) * line.quantity;
            return {
                origin_country: 'US',
                description: getEnTranslation(line.productVariant)?.name || 'Unknown',
                quantity: line.quantity,
                value,
                weight,
                code: line.productVariant.sku || 'Unknown',
                hs_tariff_number: line.productVariant.product.customFields.harmonizedCode || '8529.10.9100',
                currency: 'USD',
            } as ICustomsItem;
        });

    // Mark the to_address and from_address as Partial<IAddress>
    const shipmentDef: EasyPostShipmentDef = {
        to_address: toEasyPostAddress(order.shippingAddress, order.customer?.emailAddress),

        from_address: getEasyPostOriginAddress(),

        parcel: { ...dims },

        customs_info: {
            contents_type: 'merchandise',
            contents_explanation: '',
            customs_certify: true,
            customs_signer: process.env.CUSTOMS_SIGNER || process.env.SHIP_FROM_NAME || 'Unknown',
            non_delivery_option: 'return',
            restriction_type: 'none',
            restriction_comments: '',
            customs_items: customs_items,
            eel_pfc: 'NOEEI 30.37(a)', // for values over $2500, this would ned to be an AES ITN
        },
        options: {
            incoterm: 'DAP',
            // @ts-expect-error
            label_size: '4x6',
            label_format: 'ZPL',
            merchant_id: process.env.SHIP_FROM_COMPANY || '',
            content_description: 'Merchandise',
        },
        postage_label: {
            label_size: '4x6',
        },
    };

    // @TODO: allow specifying an ITN for international shipments over $2500?
    if (
        enforceExportValue &&
        totalValue > 2500 &&
        !compareStrings(shipmentDef.to_address.country, 'United States')
    ) {
        throw new Error(
            `International shipments over $2500 require an Automated Export System (AES) Internal Transaction Number (ITN)`,
        );
    }

    return shipmentDef;
}

export function improvedCalculateOrderShipDimensions(order: Pick<Order, 'lines'>) {
    return improvedCalculateShipDimensions(order.lines);
}

export function improvedCalculateShipDimensions(lines: OrderLine[]) {
    // Sum the weights
    const totalWeight = Math.max(
        lines.reduce(
            (sum, line) => sum + (line.productVariant.customFields?.shipping_weight || 0) * line.quantity,
            0,
        ),
        1, // Ensure minimum weight of 1 oz
    );

    // Find the maximum dimensions
    let maxLength = 0;
    let maxWidth = 0;
    let maxHeight = 0;

    // Calculate total volume (with some extra space)
    const totalVolume = lines.reduce((sum, line) => {
        const length = line.productVariant.customFields?.length || 0;
        const width = line.productVariant.customFields?.width || 0;
        const height = line.productVariant.customFields?.height || 0;

        // Update max dimensions
        maxLength = Math.max(maxLength, length);
        maxWidth = Math.max(maxWidth, width);
        maxHeight = Math.max(maxHeight, height);

        // Add volume for each item in the line
        return sum + length * width * height * line.quantity * 1.2; // 20% extra space
    }, 0);

    // Estimate dimensions based on total volume and max dimensions, prioritizing width
    const estimatedHeight = Math.max(Math.cbrt(totalVolume / (maxLength * maxWidth)), maxHeight);
    const estimatedWidth = Math.max(totalVolume / (maxLength * estimatedHeight), maxWidth);
    const estimatedLength = Math.max(Math.sqrt(totalVolume / (estimatedWidth * estimatedHeight)), maxLength);

    // console.log(
    //     `Dimensions calculated: ${totalWeight} oz, ${estimatedHeight}x${estimatedWidth}x${estimatedLength} in`,
    // );

    return {
        weightInOunces: totalWeight,
        heightInInches: Math.ceil(estimatedHeight),
        widthInInches: Math.ceil(estimatedWidth),
        lengthInInches: Math.ceil(estimatedLength),
    };
}

/**
 * Formats a carrier name and shipping method into a human-readable string.
 *
 * @param {string} name - The shipping method name (e.g., 'ExpressMailInternational', 'FEDEX_GROUND', 'UPSSaver').
 * @param {string} carrier - The carrier name (e.g., 'usps', 'FedEx', 'UPS').
 * @returns {string} A formatted string combining the carrier name and shipping method.
 *
 * @example
 * formatCarrierName('ExpressMailInternational', 'usps')
 * // Returns: "USPS Express Mail International"
 *
 * @example
 * formatCarrierName('FEDEX_GROUND', 'FedEx')
 * // Returns: "FedEx Ground"
 *
 * @example
 * formatCarrierName('UPSSaver', 'UPS')
 * // Returns: "UPS Saver"
 */
export function formatShipServiceName(name: any, carrier: any) {
    // Normalize carrier name
    const formattedCarrier = carrier.replace(/\s*express\s*/i, ' ').trim();

    let processedName = name;

    // Remove carrier name from the beginning of processedName if it's there
    const carrierRegex = new RegExp(`^${formattedCarrier}\\s*`, 'i');
    processedName = processedName.replace(carrierRegex, '').trim();

    // Process the name
    processedName = processedName
        .replace(/_/g, ' ') // Replace underscores with spaces
        .replace(/([a-z])([A-Z])/g, '$1 $2') // Split camelCase
        .replace(/\s+/g, ' ') // Replace multiple spaces with a single space
        .trim();

    // Convert to lowercase if the entire string is uppercase
    if (processedName === processedName.toUpperCase()) {
        processedName = processedName.toLowerCase();
    }

    // Capitalize the first letter of each word, except for special cases
    processedName = processedName.replace(/\b\w+/g, (word: any) => {
        // Keep abbreviations (two or more uppercase letters) as is
        if (word.toUpperCase() === word && word.length > 1) return word;
        // Handle ordinal numbers (e.g., 2nd, 3rd, 4th)
        if (/^[0-9]+(st|nd|rd|th)$/i.test(word)) {
            return word.replace(
                /([0-9]+)(st|nd|rd|th)/i,
                (match: any, p1: any, p2: any) => p1 + p2.toLowerCase(),
            );
        }
        // Keep special words like "AM", "PM" as is
        if (/^(am|pm)$/i.test(word)) return word.toUpperCase();
        // Capitalize the first letter of other words
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    });

    // Combine carrier and name
    return `${formattedCarrier} ${processedName}`.trim();
}

export function getFulfillmentOrderLines(orders: Order[], lines: OrderLineInput[]): OrderLine[] {
    const allOrderLines = orders.flatMap(o => o.lines);
    const fulfillmentOrderLines: OrderLine[] = [];
    for (const line of lines) {
        const orderLine = allOrderLines.find(l => l.id === line.orderLineId);
        if (orderLine) {
            const clone = structuredClone(orderLine);
            clone.quantity = line.quantity;
            fulfillmentOrderLines.push(clone);
        }
    }
    return fulfillmentOrderLines;
}
