import { type IsoDate, type Piastres } from "./ledger";
import type { Currency, Rate } from "./currency";
import type { WithholdingInput } from "./withholding";
/** Customers owe the business (their documents are debits); the business owes suppliers (credits). */
export type PartyKind = "customer" | "supplier";
export type PaymentInput = {
    date: IsoDate;
    /** The customer paying, or the supplier being paid. */
    partyId: number;
    /** The cash, bank or wallet account the money goes into or comes out of. */
    accountId: number;
    /** In the party's currency: piastres, or the minor units of a foreign supplier's currency. */
    amount: Piastres;
    /** EGP per unit of a foreign supplier's currency, in millionths; left out for EGP. */
    rate?: Rate;
    reference: string;
    /** Documents this payment settles, by their journal entry (see `openDocuments`). Any rest settles the oldest first. */
    allocations?: {
        entryId: number;
        amount: Piastres;
    }[];
    /**
     * Withholding tax held back from `amount`, which stays the full amount settled: the cash
     * that moves is `amount` less the tax. EGP only.
     */
    withholding?: WithholdingInput;
};
export type PaymentResult = {
    id: number;
    number: number;
};
/** A document that raised what a party owes (an invoice, a credit sale, an opening balance). */
export type OpenDocument = {
    entryId: number;
    date: IsoDate;
    memo: string;
    amount: Piastres;
    open: Piastres;
};
export type StatementLine = {
    date: IsoDate;
    entryId: number;
    memo: string;
    debit: Piastres;
    credit: Piastres;
    balance: Piastres;
};
export type Statement = {
    partyId: number;
    name: string;
    currency: Currency;
    from: IsoDate;
    to: IsoDate;
    opening: Piastres;
    lines: StatementLine[];
    closing: Piastres;
};
/** What a party owes by the age of the documents still open: 0–30, 31–60, 61–90, over 90 days. */
export type AgingRow = {
    partyId: number;
    name: string;
    buckets: [Piastres, Piastres, Piastres, Piastres];
    unapplied: Piastres;
    balance: Piastres;
};
export type Aging = {
    asOf: IsoDate;
    rows: AgingRow[];
    totals: AgingRow["buckets"];
    unapplied: Piastres;
    balance: Piastres;
};
