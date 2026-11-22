import type { BasisPoints } from "./items";
import type { IsoDate, Piastres } from "./ledger";
import type { PartyKind } from "./settlements";
/**
 * Egyptian withholding tax (الخصم والإضافة): a share of a payment held back by the payer
 * and paid to the tax authority on the payee's behalf, at a rate set by what is being paid for.
 */
export type WithholdingCategory = {
    id: number;
    name: string;
    rates: {
        from: IsoDate;
        rate: BasisPoints;
    }[];
};
/** Withholding on one payment: the category and the value it is taken on (the documents' value before VAT). */
export type WithholdingInput = {
    categoryId: number;
    base: Piastres;
};
export type WithholdingRow = {
    /** "supplier": we withheld and owe it to the authority. "customer": the customer withheld and we hold a credit. */
    kind: PartyKind;
    date: IsoDate;
    number: number;
    partyName: string;
    taxRegistrationNumber: string;
    category: string;
    rate: BasisPoints;
    base: Piastres;
    tax: Piastres;
};
export type WithholdingReport = {
    from: IsoDate;
    to: IsoDate;
    rows: WithholdingRow[];
    withheld: Piastres;
    suffered: Piastres;
};
