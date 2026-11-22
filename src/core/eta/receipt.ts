import { createHash } from "node:crypto";
import { type EtaAddress, type EtaTaxKind, canonical, itemType } from "./document";

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
  seller: { rin: string; name: string; activityCode: string; address: EtaAddress; deviceSerialNumber: string };
  /** C cash, V card, O other (wallets, on account). */
  paymentMethod: "C" | "V" | "O";
  lines: EtaReceiptLineInput[];
};

const SUBTYPE: Record<EtaTaxKind, string> = { standard: "V009", zero_rated: "V001", exempt: "V003" };
const pounds = (piastres: number) => Number((piastres / 100).toFixed(2));
const units = (thousandths: number) => Number((thousandths / 1000).toFixed(3));

/** Splits a VAT-inclusive discount into the part before VAT, at the line's rate. */
const beforeVat = (amount: number, rate: number) => Math.round((amount * 10_000) / (10_000 + rate));

/**
 * The e-receipt (v1.2) as the ETA takes it, with its UUID: SHA-256 of the receipt's canonical
 * form with an empty UUID, in hex. Each receipt names the one before it, so the POS's receipts form a chain.
 */
export function etaReceipt(input: EtaReceiptInput): { receipt: Record<string, unknown>; uuid: string } {
  const parts = input.lines.map((l) => {
    const discount = beforeVat(l.gross - l.net - l.vat, l.vatRate);
    return { discount, totalSale: l.net + discount };
  });
  const lines = input.lines.map((l, i) => {
    const { discount, totalSale } = parts[i]!;
    return {
      internalCode: l.internalCode,
      description: l.description,
      itemType: itemType(l.itemCode),
      itemCode: l.itemCode,
      unitType: "EA",
      quantity: units(l.quantity),
      unitPrice: Number((totalSale / 100 / (l.quantity / 1000)).toFixed(5)),
      netSale: pounds(l.net),
      totalSale: pounds(totalSale),
      total: pounds(l.net + l.vat),
      commercialDiscountData: discount > 0 ? [{ amount: pounds(discount), description: "Discount" }] : [],
      itemDiscountData: [],
      valueDifference: 0,
      taxableItems: [{ taxType: "T1", amount: pounds(l.vat), subType: SUBTYPE[l.taxKind], rate: l.vatRate / 100 }],
    };
  });
  const total = (pick: (p: (typeof parts)[number]) => number) => parts.reduce((t, p) => t + pick(p), 0);
  const vat = input.lines.reduce((t, l) => t + l.vat, 0);
  const net = input.lines.reduce((t, l) => t + l.net, 0);
  const build = (uuid: string) => ({
    header: {
      dateTimeIssued: input.issuedAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
      receiptNumber: input.receiptNumber,
      uuid,
      previousUUID: input.previousUuid,
      referenceOldUUID: input.referenceUuid ?? "",
      currency: "EGP",
      exchangeRate: 0,
      sOrderNameCode: "",
      orderdeliveryMode: "",
      grossWeight: 0,
      netWeight: 0,
    },
    documentType: { receiptType: input.type === "S" ? "S" : "R", typeVersion: "1.2" },
    seller: {
      rin: input.seller.rin,
      companyTradeName: input.seller.name,
      branchCode: "0",
      branchAddress: { country: "EG", ...input.seller.address },
      deviceSerialNumber: input.seller.deviceSerialNumber,
      syndicateLicenseNumber: "",
      activityCode: input.seller.activityCode,
    },
    buyer: { type: "P", id: "", name: "", mobileNumber: "", paymentNumber: "" },
    itemData: lines,
    totalSales: pounds(total((p) => p.totalSale)),
    totalCommercialDiscount: pounds(total((p) => p.discount)),
    totalItemsDiscount: 0,
    extraReceiptDiscountData: [],
    netAmount: pounds(net),
    feesAmount: 0,
    totalAmount: pounds(net + vat),
    taxTotals: [{ taxType: "T1", amount: pounds(vat) }],
    paymentMethod: input.paymentMethod,
    adjustment: 0,
  });
  const uuid = createHash("sha256")
    .update(canonical(build("")))
    .digest("hex");
  return { receipt: build(uuid), uuid };
}

/** What the receipt's QR code holds: the ETA's public page for it, with its time, total and the seller's tax number. */
export function receiptQr(input: { uuid: string; issuedAt: string; total: number; rin: string; production: boolean }): string {
  const host = input.production ? "invoicing.eta.gov.eg" : "preprod.invoicing.eta.gov.eg";
  return `https://${host}/receipts/search/${input.uuid}/share/${input.issuedAt}#Total:${pounds(input.total)},IssuerRIN:${input.rin}`;
}
