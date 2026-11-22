import type { EtaAddress, EtaTaxKind } from "./document";
/** One till line, in the app's units; amounts are VAT-inclusive as the till keeps them. */
export type EtaReceiptLineInput = {
    description: string;
    itemCode: string;
    internalCode: string;
    quantity: number;
    /** Before discounts, VAT included. */
    gross: number;
    /** After discounts, VAT excluded. */
    net: number;
    vat: number;
    vatRate: number;
    taxKind: EtaTaxKind;
};
export type EtaReceiptInput = {
    /** "S" a sale, "R" a return against an earlier receipt. */
    type: "S" | "R";
    receiptNumber: string;
    issuedAt: Date;
    /** The UUID of the receipt this POS sent before this one; "" for its first. */
    previousUuid: string;
    /** A return's original receipt. */
    referenceUuid?: string;
    seller: {
        rin: string;
        name: string;
        activityCode: string;
        address: EtaAddress;
        deviceSerialNumber: string;
    };
    /** C cash, V card, O other (wallets, on account). */
    paymentMethod: "C" | "V" | "O";
    lines: EtaReceiptLineInput[];
};
