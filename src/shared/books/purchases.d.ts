import { type Currency, type Rate } from "./currency";
import type { BasisPoints, Quantity } from "./items";
import type { IsoDate, Piastres } from "./ledger";
import type { SerialLine, UnitLine } from "./stock";
export type { Currency, Rate } from "./currency";
export type Supplier = {
    id: number;
    name: string;
    phone: string;
    taxRegistrationNumber: string;
    currency: Currency;
    /** The withholding tax category the business usually deducts under when paying them; null is none. */
    withholdingCategoryId: number | null;
    active: boolean;
};
export type SupplierInput = {
    name: string;
    phone: string;
    taxRegistrationNumber: string;
    currency?: Currency;
    withholdingCategoryId?: number | null;
};
export type SupplierChanges = Partial<SupplierInput>;
/** A purchase line: quantity in thousandths of the chosen unit, price per one of that unit, VAT-exclusive. */
export type PurchaseLineInput = UnitLine & SerialLine & {
    unitPrice: Piastres;
};
export type PurchaseInvoiceInput = {
    date: IsoDate;
    supplierId: number;
    warehouseId: number;
    /** The supplier's own invoice number. */
    reference: string;
    /** EGP per unit of the supplier's currency, in millionths; required when they bill in another currency. */
    rate?: Rate;
    /** In the supplier's currency: prices and amounts in its minor units. */
    lines: PurchaseLineInput[];
};
export type PurchaseLine = PurchaseLineInput & {
    net: Piastres;
    vatRate: BasisPoints;
    vat: Piastres;
};
/** A posted purchase line, with how much of it already went back to the supplier. */
export type PostedPurchaseLine = PurchaseLine & {
    lineId: number;
    nameAr: string;
    returned: Quantity;
    /** The serials received on this line, for a serialised item. */
    serials: string[];
};
export type PurchaseInvoice = {
    id: number;
    date: IsoDate;
    supplierId: number;
    warehouseId: number;
    reference: string;
    currency: Currency;
    rate: Rate;
    /** In the invoice's currency. */
    net: Piastres;
    vat: Piastres;
    total: Piastres;
    /** What the invoice put on the supplier's account in EGP. */
    totalEgp: Piastres;
    postedBy: string;
    lines: PostedPurchaseLine[];
};
/** What the business owes the supplier in their own currency, and what that stands at in EGP in the books. */
export type SupplierAccount = {
    currency: Currency;
    owed: number;
    owedEgp: Piastres;
};
/** Amounts in the invoice's currency, and the total in EGP at the invoice's rate. */
export type PricedPurchase = {
    lines: PurchaseLine[];
    net: Piastres;
    vat: Piastres;
    total: Piastres;
    totalEgp: Piastres;
};
/** The currency an invoice is in and its rate; EGP at one when left out. */
export type PurchaseMoney = {
    currency: Currency;
    rate: Rate;
};
