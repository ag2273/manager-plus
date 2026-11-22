/**
 * Sales invoices and credit notes in the Egyptian Tax Authority's JSON document format (v1.0),
 * and the canonical text of a document that its signature covers.
 */
export type EtaAddress = {
    governate: string;
    regionCity: string;
    street: string;
    buildingNumber: string;
};
export type EtaParty = {
    rin: string;
    name: string;
    address: EtaAddress;
};
export type EtaTaxKind = "standard" | "zero_rated" | "exempt";
/** One line, in the app's own units: thousandths, piastres and basis points. */
export type EtaLineInput = {
    description: string;
    /** An EGS code ("EG-<RIN>-<code>") or a GS1 barcode (GTIN). */
    itemCode: string;
    internalCode: string;
    /** The ETA unit code: "EA" for a piece. */
    unitType: string;
    quantity: number;
    /** Before discount and VAT: quantity × unit price. */
    salesTotal: number;
    discount: number;
    net: number;
    vat: number;
    vatRate: number;
    taxKind: EtaTaxKind;
};
export type EtaDocumentInput = {
    type: "I" | "C";
    issuer: EtaParty & {
        activityCode: string;
    };
    receiver: EtaParty;
    internalId: string;
    /** UTC, to the second. */
    issuedAt: Date;
    lines: EtaLineInput[];
    /** A credit note's original invoice, by its ETA UUID. */
    references?: string[];
};
