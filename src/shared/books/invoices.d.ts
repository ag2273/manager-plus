import { type CreditApproval } from "./customers";
import type { BasisPoints, Quantity } from "./items";
import type { IsoDate, Piastres } from "./ledger";
import type { SerialLine, UnitLine } from "./stock";
/** An invoice line: price per one of the chosen unit and a discount in piastres, both VAT-exclusive. */
export type InvoiceLineInput = UnitLine & SerialLine & {
    unitPrice: Piastres;
    discount?: Piastres;
};
export type InvoiceLine = UnitLine & {
    unitPrice: Piastres;
    /** Quantity × unit price. */
    gross: Piastres;
    discount: Piastres;
    net: Piastres;
    vatRate: BasisPoints;
    vat: Piastres;
};
export type PricedInvoice = {
    lines: InvoiceLine[];
    gross: Piastres;
    discount: Piastres;
    net: Piastres;
    vat: Piastres;
    total: Piastres;
};
export type SalesInvoiceInput = {
    date: IsoDate;
    customerId: number;
    warehouseId: number;
    /** The customer's order number or similar. */
    reference: string;
    notes: string;
    lines: InvoiceLineInput[];
    /** The quotation this invoice comes from; it is marked converted. */
    quotationId?: number;
    /** A manager's sign-in when the invoice takes the customer past their credit limit. */
    creditApproval?: CreditApproval;
};
export type SalesInvoiceResult = {
    id: number;
    number: number;
    total: Piastres;
    belowZero: number[];
};
export type SalesInvoice = {
    id: number;
    number: number;
    date: IsoDate;
    customerId: number;
    customerName: string;
    warehouseId: number;
    reference: string;
    notes: string;
    postedBy: string;
    gross: Piastres;
    discount: Piastres;
    net: Piastres;
    vat: Piastres;
    total: Piastres;
    /** The total of credit notes against the invoice. */
    credited: Piastres;
    creditNotes: {
        number: number;
        date: IsoDate;
        total: Piastres;
    }[];
    lines: (InvoiceLine & {
        lineId: number;
        nameAr: string;
        nameEn: string;
        unitName: string;
        credited: Quantity;
        serials: string[];
        warrantyEnds: IsoDate | null;
    })[];
};
export type CreditNoteInput = {
    date: IsoDate;
    invoiceId: number;
    reason: string;
    /** Invoice lines and how much of each comes back, in thousandths of the line's unit. */
    lines: {
        lineId: number;
        quantity: Quantity;
        serials?: string[];
    }[];
};
export type CreditNote = {
    id: number;
    number: number;
    date: IsoDate;
    invoiceNumber: number;
    customerId: number;
    customerName: string;
    reason: string;
    postedBy: string;
    net: Piastres;
    vat: Piastres;
    total: Piastres;
    lines: {
        itemId: number;
        nameAr: string;
        nameEn: string;
        unit: "base" | "pack";
        unitName: string;
        quantity: Quantity;
        unitPrice: Piastres;
        net: Piastres;
        vat: Piastres;
    }[];
};
/** A till receipt to be replaced by a tax invoice to a customer. */
export type ReceiptInvoiceInput = {
    date: IsoDate;
    receiptId: number;
    customerId: number;
    /** The customer's order number or similar. */
    reference?: string;
};
export type ReceiptInvoiced = {
    returnId: number;
    returnNumber: number;
    invoiceId: number;
    invoiceNumber: number;
    total: Piastres;
};
