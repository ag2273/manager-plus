import type { IsoDate, Piastres } from "./ledger";
import type { InvoiceLine, InvoiceLineInput } from "./invoices";
export type QuotationLineInput = Omit<InvoiceLineInput, "serials">;
export type QuotationInput = {
    date: IsoDate;
    /** The last day the prices stand. */
    validUntil: IsoDate;
    customerId: number;
    /** The customer's request number or similar. */
    reference: string;
    notes: string;
    lines: QuotationLineInput[];
};
export type QuotationStatus = "open" | "expired" | "converted";
export type Quotation = {
    id: number;
    number: number;
    date: IsoDate;
    validUntil: IsoDate;
    customerId: number;
    customerName: string;
    reference: string;
    notes: string;
    preparedBy: string;
    status: QuotationStatus;
    /** The sales invoice it became, once converted. */
    invoiceNumber: number | null;
    gross: Piastres;
    discount: Piastres;
    net: Piastres;
    vat: Piastres;
    total: Piastres;
    lines: (InvoiceLine & {
        nameAr: string;
        nameEn: string;
        unitName: string;
    })[];
};
