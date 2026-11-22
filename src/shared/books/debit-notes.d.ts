import type { Quantity } from "./items";
import type { IsoDate, Piastres } from "./ledger";
export type DebitNoteInput = {
    date: IsoDate;
    purchaseInvoiceId: number;
    reason: string;
    /** Purchase invoice lines and how much of each goes back, in thousandths of the line's unit. */
    lines: {
        lineId: number;
        quantity: Quantity;
        serials?: string[];
    }[];
};
export type DebitNote = {
    id: number;
    number: number;
    date: IsoDate;
    purchaseInvoiceId: number;
    supplierId: number;
    reason: string;
    postedBy: string;
    net: Piastres;
    vat: Piastres;
    total: Piastres;
    lines: {
        itemId: number;
        nameAr: string;
        unit: "base" | "pack";
        quantity: Quantity;
        net: Piastres;
        vat: Piastres;
    }[];
};
