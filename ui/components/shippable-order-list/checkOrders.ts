import { Fulfillment, Order, OrderCustomFields } from '../../generated-types';

interface StockLevel {
    stockOnHand: number;
    stockAllocated: number;
}
type StockLevelMap = Record<string, StockLevel>;

interface LineFromOrder {
    sku: string;
    quantity: number;
}

const fulfillmentAllocated = ['Pending'];
const fulfillmentActive = ['Created', 'Pending', 'OnHold'];

export type MinimalOrder = {
    id: string;
    code: string;
    state: Order['state'];
    fulfillments?: MinimalFulfillment[];
    lines: MinimalOrderLine[];
    customFields?: Pick<OrderCustomFields, 'carrierCode' | 'serviceCode'>;
};

export type MinimalOrderLine = {
    id: string;
    productVariant: {
        sku: string;
    };
    quantity: number;
};

export type MinimalFulfillment = {
    id: Fulfillment['id'];
    state: Fulfillment['state'];
    lines: {
        orderLineId: string;
        quantity: number;
    }[];
};

function getLinesFromFulfillment(
    fulfillment: MinimalFulfillment,
    orderLineMap: Record<string, MinimalOrderLine>,
): LineFromOrder[] {
    // This could happen if you try to print an order with a merged fulfillment
    // but only have one of the two orders in the list
    if (fulfillment.lines.some(l => !(l.orderLineId in orderLineMap))) {
        throw new Error('Fulfillment contains lines which are not part of the order');
    }
    const lines = fulfillment.lines.map(l => ({
        sku: orderLineMap[l.orderLineId].productVariant.sku,
        quantity: l.quantity,
    }));
    return lines;
}
function getLinesFromOrder(order: MinimalOrder): LineFromOrder[] {
    const lines = order.lines.map(l => ({
        sku: l.productVariant.sku,
        quantity: l.quantity,
    }));
    return lines;
}

interface OrderCheckInsufficientStockError {
    type: 'insufficient-stock';
    id: string;
    code: string;
    lines: {
        sku: string;
        requested: number;
        available: number;
    }[];
}
interface OrderCheckNoShippingMethodError {
    type: 'no-shipping-method';
    id: string;
    code: string;
}
interface OrderCheckNotAllOrdersSelected {
    type: 'not-all-orders-selected';
    id: string;
    code: string;
}
type OrderCheckError =
    | OrderCheckInsufficientStockError
    | OrderCheckNoShippingMethodError
    | OrderCheckNotAllOrdersSelected;

export interface OrderCheckResult {
    errors: OrderCheckError[];

    orderCount: number;

    /** How many orders are unfillable due to insufficient stock */
    insufficientStock: number;

    pickList: {
        /** SKU of the variant */
        sku: string;
        /** How many needed to fill the accepted orders that haven't been allocated */
        quantityNeeded: number;
        /** How many total will be used to fill these orders including what is allocated */
        quantityUsed: number;
        /** How many of this variant are in stock */
        onHand: number;
        /** How many are allocated total */
        totalAllocated: number;
    }[];
}

function adjustStock(stockMap: StockLevelMap, sku: string, quantity: number): void {
    if (!stockMap[sku]) {
        stockMap[sku] = { stockOnHand: 0, stockAllocated: 0 };
    }
    stockMap[sku].stockAllocated += quantity;
    stockMap[sku].stockOnHand -= quantity;
}

function getStockFrom(stockMap: StockLevelMap, sku: string): number {
    return stockMap[sku]?.stockOnHand || 0;
}

/**
 * Checks orders against available inventory to see if they can all be fulfilled.
 *
 * You must hydrate:
 * - order.lines
 * - order.lines.productVariant
 * - order.fulfillments
 * - order.fulfillments.lines
 * - order.fulfillments.lines.orderLine
 *
 * @param orderList List of orders in the order of priority
 * @param stockMap Map of stock levels keyed by SKU
 * @returns { OrderCheckResult } The result of the check
 */
export function checkOrders(orderList: MinimalOrder[], stockMap: StockLevelMap): OrderCheckResult {
    const testAllocatedStock: StockLevelMap = {};
    const preAllocatedStock: StockLevelMap = {};
    const errors: OrderCheckError[] = [];

    const totalNeeded: StockLevelMap = {};

    // First we need a map of all order lines
    const allOrderLines: Record<string, MinimalOrderLine> = {};
    for (const order of orderList) {
        for (const line of order.lines) {
            allOrderLines[line.id] = line;
        }
    }

    let insufficientStock = 0;
    const processedFulfillmentIds: MinimalFulfillment['id'][] = [];
    for (const order of orderList) {
        const currentFulfillment = (order.fulfillments || [])?.find(f => fulfillmentActive.includes(f.state));
        const allocatedFullfillments = (order.fulfillments || []).filter(f =>
            fulfillmentAllocated.includes(f.state),
        );

        // First check if a shipping method has been selected
        let shippingError: OrderCheckNoShippingMethodError | null = null;
        if (!currentFulfillment && (!order.customFields?.carrierCode || !order.customFields?.serviceCode)) {
            shippingError = {
                type: 'no-shipping-method',
                id: order.id,
                code: order.code,
            };
        }

        let orderLines: LineFromOrder[];
        // if any of these throw an error, it's only because getLinesFromFulfillment threw
        // due to one or more of the orders not being in the list; add error and continue
        try {
            if (allocatedFullfillments.length > 0) {
                // This order has fulfillments which are in a non-purchased state from which
                // stock has been allocated already; we need to add to the pick list, but
                // we don't need to check stock levels for these lines
                orderLines = allocatedFullfillments
                    .filter(f => !processedFulfillmentIds.includes(f.id))
                    .flatMap(f => {
                        const lines = getLinesFromFulfillment(f, allOrderLines);
                        processedFulfillmentIds.push(f.id);
                        return lines;
                    });
                for (const line of orderLines) {
                    adjustStock(preAllocatedStock, line.sku, line.quantity);
                }
                continue;
            } else if (currentFulfillment && processedFulfillmentIds.includes(currentFulfillment.id)) {
                // This order has a fulfillment which has already been processed
                // (either because it was pre-allocated or because it was already processed)
                // so we can skip it
                continue;
            } else if (currentFulfillment) {
                // For the purpose of this, we only consider the first one
                orderLines = getLinesFromFulfillment(currentFulfillment, allOrderLines);
                processedFulfillmentIds.push(currentFulfillment.id);
            } else {
                orderLines = getLinesFromOrder(order);
            }
        } catch (e) {
            errors.push({
                type: 'not-all-orders-selected',
                id: order.id,
                code: order.code,
            });
            continue;
        }

        const locallyAllocatedStock: StockLevelMap = {};
        const stockError: OrderCheckInsufficientStockError = {
            type: 'insufficient-stock',
            id: order.id,
            code: order.code,
            lines: [],
        };
        for (const line of orderLines) {
            const sku = line.sku;
            const currentStock =
                getStockFrom(stockMap, sku) +
                getStockFrom(testAllocatedStock, sku) +
                getStockFrom(locallyAllocatedStock, sku);

            if (line.quantity > currentStock) {
                // We don't have enough stock to fill this order
                stockError.lines.push({
                    sku: line.sku,
                    requested: line.quantity,
                    available: currentStock,
                });
            }
            // add the stock to the locally allocated stock
            adjustStock(locallyAllocatedStock, sku, line.quantity);
        }
        if (stockError.lines.length) {
            insufficientStock++;
            errors.push(stockError);
        } else if (shippingError) {
            errors.push(shippingError);
        }
        // Add local stock to the test allocated stock
        for (const [sku, stock] of Object.entries(locallyAllocatedStock)) {
            adjustStock(testAllocatedStock, sku, stock.stockAllocated);
        }
    }
    // first populate the pick list from the unallocated entries
    const pickList = Object.entries(testAllocatedStock).map(([sku, stock]) => ({
        sku,
        quantityNeeded: stock.stockAllocated,
        quantityUsed: stock.stockAllocated,
        onHand: stockMap[sku].stockOnHand,
        totalAllocated: stockMap[sku].stockAllocated,
    }));

    // next add the pre-allocated stock to the pick list
    for (const [sku, stock] of Object.entries(preAllocatedStock)) {
        if (stock.stockAllocated > 0) {
            // This should always be true if it's in the object
            const existing = pickList.find(p => p.sku === sku);
            if (existing) {
                existing.quantityUsed += stock.stockAllocated;
            } else {
                pickList.push({
                    sku,
                    quantityNeeded: 0,
                    // This was preallocated, so we don't need to adjust it
                    quantityUsed: stock.stockAllocated,
                    onHand: stockMap[sku].stockOnHand,
                    totalAllocated: stockMap[sku].stockAllocated,
                });
            }
        }
    }

    // sort picklist by SKU
    pickList.sort((a, b) => a.sku.localeCompare(b.sku));

    // and return it
    return {
        errors,
        orderCount: orderList.length,
        insufficientStock,
        pickList: pickList.filter(p => p.quantityUsed > 0),
    };
}
