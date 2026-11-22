import type { IsoDate, Piastres } from "./ledger";
export type TaxKind = "standard" | "zero_rated" | "exempt";
export type VatSection = "sales" | "purchases" | "expenses" | "imports";
/** One document's lines under one tax kind: what each figure on the return drills down to. */
export type VatTransaction = {
    section: VatSection;
    taxKind: TaxKind;
    /** sale, sale_return, sales_invoice, credit_note, purchase_invoice, debit_note, expense, expense_void, import_shipment */
    kind: string;
    /** The document's number; a purchase invoice shows the supplier's reference instead. */
    number: string;
    date: IsoDate;
    party: string;
    net: Piastres;
    vat: Piastres;
    entryId: number;
};
export type VatBox = {
    section: VatSection;
    taxKind: TaxKind;
    net: Piastres;
    vat: Piastres;
};
export type VatReturn = {
    from: IsoDate;
    to: IsoDate;
    /** Sales and purchases per tax kind, then expenses and VAT paid at customs; empty boxes left out. */
    boxes: VatBox[];
    outputVat: Piastres;
    inputVat: Piastres;
    /**
     * What the VAT accounts moved by in the period beyond the documents above, such as journal
     * entries posted straight to them. Zero when everything went through documents.
     */
    outputAdjustments: Piastres;
    inputAdjustments: Piastres;
    /** Output less input, adjustments included; negative is VAT to carry forward. */
    netDue: Piastres;
    transactions: VatTransaction[];
};
