/**
 * Sales invoices and credit notes in the Egyptian Tax Authority's JSON document format (v1.0),
 * and the canonical text of a document that its signature covers.
 */

export type EtaAddress = { governate: string; regionCity: string; street: string; buildingNumber: string };
export type EtaParty = { rin: string; name: string; address: EtaAddress };
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
  issuer: EtaParty & { activityCode: string };
  receiver: EtaParty;
  internalId: string;
  /** UTC, to the second. */
  issuedAt: Date;
  lines: EtaLineInput[];
  /** A credit note's original invoice, by its ETA UUID. */
  references?: string[];
};

/** T1 (VAT) subtypes. Zero-rated sales are exports (V001); exempt goods V003; everything else V009. */
const SUBTYPE: Record<EtaTaxKind, string> = { standard: "V009", zero_rated: "V001", exempt: "V003" };

/** Piastres as pounds, thousandths as units: exact decimals JSON prints without float noise. */
const pounds = (piastres: number) => Number((piastres / 100).toFixed(2));
const units = (thousandths: number) => Number((thousandths / 1000).toFixed(3));
const sum = (lines: EtaLineInput[], pick: (l: EtaLineInput) => number) => lines.reduce((t, l) => t + pick(l), 0);

/** The item type ETA expects for a code: EGS for the business's own "EG-…" codes, GS1 otherwise. */
export const itemType = (code: string) => (code.toUpperCase().startsWith("EG-") ? "EGS" : "GS1");

const address = (a: EtaAddress, branchID?: string) => ({
  ...(branchID === undefined ? {} : { branchID }),
  country: "EG",
  governate: a.governate,
  regionCity: a.regionCity,
  street: a.street,
  buildingNumber: a.buildingNumber,
});

/** The document as the ETA takes it, without its signatures. */
export function etaDocument(input: EtaDocumentInput): Record<string, unknown> {
  const lines = input.lines.map((l) => ({
    description: l.description,
    itemType: itemType(l.itemCode),
    itemCode: l.itemCode,
    unitType: l.unitType,
    quantity: units(l.quantity),
    internalCode: l.internalCode,
    salesTotal: pounds(l.salesTotal),
    total: pounds(l.net + l.vat),
    valueDifference: 0,
    totalTaxableFees: 0,
    netTotal: pounds(l.net),
    itemsDiscount: 0,
    unitValue: { currencySold: "EGP", amountEGP: Number((l.salesTotal / 100 / (l.quantity / 1000)).toFixed(5)) },
    discount: { rate: 0, amount: pounds(l.discount) },
    taxableItems: [{ taxType: "T1", amount: pounds(l.vat), subType: SUBTYPE[l.taxKind], rate: l.vatRate / 100 }],
  }));
  return {
    issuer: { address: address(input.issuer.address, "0"), type: "B", id: input.issuer.rin, name: input.issuer.name },
    receiver: { address: address(input.receiver.address), type: "B", id: input.receiver.rin, name: input.receiver.name },
    documentType: input.type,
    documentTypeVersion: "1.0",
    dateTimeIssued: input.issuedAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
    taxpayerActivityCode: input.issuer.activityCode,
    internalID: input.internalId,
    ...(input.references ? { references: input.references } : {}),
    invoiceLines: lines,
    totalDiscountAmount: pounds(sum(input.lines, (l) => l.discount)),
    totalSalesAmount: pounds(sum(input.lines, (l) => l.salesTotal)),
    netAmount: pounds(sum(input.lines, (l) => l.net)),
    taxTotals: [{ taxType: "T1", amount: pounds(sum(input.lines, (l) => l.vat)) }],
    totalAmount: pounds(sum(input.lines, (l) => l.net + l.vat)),
    extraDiscountAmount: 0,
    totalItemsDiscountAmount: 0,
  };
}

/**
 * The ETA's canonical serialisation, which the signature covers: every property name in capitals
 * and quotes, followed by its value in quotes; an array repeats its property name before each element.
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return `"${String(value)}"`;
  let out = "";
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const name = `"${key.toUpperCase()}"`;
    out += name;
    if (Array.isArray(child)) for (const element of child) out += name + canonical(element);
    else out += canonical(child);
  }
  return out;
}
