import type { Quantity } from "./items";
import type { IsoDate, Piastres } from "./ledger";
import type { SerialLine, UnitLine } from "./stock";
export type StockCountInput = {
    date: IsoDate;
    warehouseId: number;
    memo: string;
    /** What was found on the shelves, in thousandths of the base unit. */
    lines: {
        itemId: number;
        counted: Quantity;
    }[];
};
export type StockCount = {
    id: number;
    date: IsoDate;
    warehouseId: number;
    memo: string;
    /** `value` is the gain (positive) or loss (negative) posted for the difference. */
    lines: {
        itemId: number;
        nameAr: string;
        expected: Quantity;
        counted: Quantity;
        difference: Quantity;
        value: Piastres;
    }[];
};
export type WriteOffInput = {
    date: IsoDate;
    warehouseId: number;
    reason: string;
    lines: (UnitLine & SerialLine)[];
};
export type WriteOff = {
    id: number;
    date: IsoDate;
    warehouseId: number;
    reason: string;
    value: Piastres;
    lines: {
        itemId: number;
        nameAr: string;
        quantity: Quantity;
        value: Piastres;
    }[];
};
export type LowStockRow = {
    itemId: number;
    nameAr: string;
    minQuantity: Quantity;
    onHand: Quantity;
    byWarehouse: {
        warehouseId: number;
        quantity: Quantity;
    }[];
};
export type ItemMovement = {
    id: number;
    date: IsoDate;
    /** The kind of document: purchase, sale, sales_invoice, transfer, write_off, stock_count, … */
    source: string;
    sourceId: number;
    warehouseId: number;
    warehouseName: string;
    quantity: Quantity;
    value: Piastres;
    /** Quantity held after this movement, in the warehouses shown. */
    balance: Quantity;
};
