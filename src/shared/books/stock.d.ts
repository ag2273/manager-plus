import type { Quantity } from "./items";
import type { IsoDate, Piastres } from "./ledger";
export type Warehouse = {
    id: number;
    name: string;
    active: boolean;
};
export type StockOnHand = {
    total: Quantity;
    byWarehouse: {
        warehouseId: number;
        quantity: Quantity;
    }[];
};
/** A line counted in the item's base unit or its pack unit, in thousandths of that unit. */
export type UnitLine = {
    itemId: number;
    unit: "base" | "pack";
    quantity: Quantity;
};
/** A line of a serialised item carries one serial number per unit. */
export type SerialLine = {
    serials?: string[];
};
export type TransferInput = {
    date: IsoDate;
    from: number;
    to: number;
    memo: string;
    lines: (UnitLine & SerialLine)[];
};
export type Transfer = {
    id: number;
    date: IsoDate;
    from: number;
    to: number;
    memo: string;
    lines: {
        itemId: number;
        quantity: Quantity;
    }[];
};
export type OpeningStockLine = {
    itemId: number;
    quantity: Quantity;
    unitCost: Piastres;
} & SerialLine;
