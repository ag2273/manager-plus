import type { Piastres } from "./ledger";
import type { Credentials } from "./users";
/** Which shelf price a customer's quotations and invoices start from. */
export type PriceLevel = "retail" | "wholesale";
export type Customer = {
    id: number;
    name: string;
    phone: string;
    taxRegistrationNumber: string;
    address: string;
    /** Governorate, city and building number: with the address (the street), what an e-invoice needs. */
    governate: string;
    regionCity: string;
    buildingNumber: string;
    priceLevel: PriceLevel;
    /** The most the customer may owe, in piastres; null is no limit. */
    creditLimit: Piastres | null;
    /** The withholding tax category the customer usually deducts under; null is none. */
    withholdingCategoryId: number | null;
    active: boolean;
};
export type CustomerInput = {
    name: string;
    phone: string;
    taxRegistrationNumber: string;
    address?: string;
    governate?: string;
    regionCity?: string;
    buildingNumber?: string;
    priceLevel?: PriceLevel;
    creditLimit?: Piastres | null;
    withholdingCategoryId?: number | null;
};
export type CustomerChanges = Partial<CustomerInput>;
/** A manager's sign-in, given on a document that takes a customer past their credit limit. */
export type CreditApproval = Credentials;
