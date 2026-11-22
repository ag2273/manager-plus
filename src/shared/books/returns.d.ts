import type { Quantity } from "./items";
import type { IsoDate, Piastres } from "./ledger";
export type ReturnInput = {
    date: IsoDate;
    receiptId: number;
    /** Receipt lines and how much of each comes back, in thousandths of the line's unit. */
    lines: {
        lineId: number;
        quantity: Quantity;
        serials?: string[];
    }[];
    /** Cash from the drawer, or credited to the receipt's customer. */
    refund: "cash" | "account";
};
export type ReturnResult = {
    id: number;
    number: number;
    total: Piastres;
};
export type SaleReturn = {
    id: number;
    number: number;
    date: IsoDate;
    at: string;
    receiptNumber: number;
    refund: "cash" | "account";
    returnedBy: string;
    total: Piastres;
    vat: Piastres;
    lines: {
        itemId: number;
        nameAr: string;
        nameEn: string;
        unit: "base" | "pack";
        quantity: Quantity;
        amount: Piastres;
        vat: Piastres;
    }[];
};
