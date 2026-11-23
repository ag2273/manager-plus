import { type BasisPoints, type Quantity } from "./items";
import type { IsoDate, Piastres } from "./ledger";
import type { CreditApproval } from "./customers";
import type { SerialLine, UnitLine } from "./stock";
/** A discount in piastres off, or a percentage in basis points (1000 = 10%). */
export type Discount = {
    kind: "amount" | "percent";
    value: number;
};
/** A till line: the item, which unit was rung up, how many (thousandths of that unit), and any discount. */
export type SaleLineInput = UnitLine & SerialLine & {
    discount?: Discount;
};
export type SaleLine = UnitLine & {
    unitPrice: Piastres;
    /** Quantity × shelf price, before discounts. */
    gross: Piastres;
    /** The line's own discount plus its share of the receipt discount. */
    discount: Piastres;
    /** What the customer pays for the line: gross − discount, VAT included. */
    amount: Piastres;
    net: Piastres;
    vatRate: BasisPoints;
    vat: Piastres;
};
export type PricedSale = {
    lines: SaleLine[];
    /** Shelf prices before any discount. */
    gross: Piastres;
    discount: Piastres;
    net: Piastres;
    vat: Piastres;
    total: Piastres;
};
export type PaymentMethod = "cash" | "card" | "wallet";
/** A tender at the till. Cash is what the customer handed over, before change. */
export type Payment = {
    method: PaymentMethod;
    amount: Piastres;
};
export type SaleInput = {
    date: IsoDate;
    warehouseId: number;
    lines: SaleLineInput[];
    payments: Payment[];
    /** A discount on the whole receipt, spread over the lines. */
    discount?: Discount;
    /** Needed when part of the total is left on credit. */
    customerId?: number;
    /** A manager's sign-in when the credit takes the customer past their limit. */
    creditApproval?: CreditApproval;
};
export type CashSaleInput = {
    date: IsoDate;
    warehouseId: number;
    lines: SaleLineInput[];
    cashReceived: Piastres;
};
export type SaleResult = CashSaleResult;
export type CashSaleResult = {
    id: number;
    number: number;
    total: Piastres;
    change: Piastres;
    /** Items whose quantity on hand went below zero with this sale. */
    belowZero: number[];
};
export type Receipt = {
    id: number;
    number: number;
    date: IsoDate;
    /** When the sale was made, as an ISO timestamp in UTC. */
    at: string;
    warehouseId: number;
    net: Piastres;
    vat: Piastres;
    total: Piastres;
    cashReceived: Piastres;
    change: Piastres;
    /** What each tender paid; cash is after change. */
    payments: Payment[];
    /** The part of the total left on the customer's account. */
    onCredit: Piastres;
    customerId: number | null;
    soldBy: string;
    /** The cashier, by user id, and the shift the sale was rung up in. */
    soldById: number;
    shiftId: number | null;
    /** The tax invoice that replaced this receipt, when it was turned into one. */
    invoiceNumber: number | null;
    eta: {
        uuid: string;
        previousUuid: string;
        status: string;
    };
    lines: (SaleLine & {
        lineId: number;
        nameAr: string;
        nameEn: string;
        cost: Piastres;
        returned: Quantity;
        serials: string[];
        warrantyEnds: IsoDate | null;
    })[];
};
export type HeldSaleInput = {
    warehouseId: number;
    lines: SaleLineInput[];
    discount?: Discount;
    note: string;
};
export type HeldSale = HeldSaleInput & {
    id: number;
    at: string;
    heldBy: string;
};

/** Which till receipts to list: a date range, and optionally one shift or one cashier. */
export type ReceiptFilter = {
    from: string;
    to: string;
    shiftId?: number;
    userId?: number;
};
