import type { AccountRole, AccountType } from "./chart-of-accounts";
/** Whole piastres (1/100 EGP). Never a fraction. */
export type Piastres = number;
/** A calendar date as YYYY-MM-DD. */
export type IsoDate = string;
export type Account = {
    id: number;
    code: string;
    name: string;
    type: AccountType;
    role: AccountRole | null;
    active: boolean;
};
export type JournalLine = {
    accountId: number;
    debit?: Piastres;
    credit?: Piastres;
    memo?: string;
    /** The supplier a payables line belongs to. */
    supplierId?: number;
    /** The customer a receivables line belongs to. */
    customerId?: number;
    /** On a payables line of a supplier billing in another currency: the same amount in that currency. */
    foreign?: number;
};
export type JournalEntryInput = {
    date: IsoDate;
    memo: string;
    lines: JournalLine[];
};
export type TrialBalanceRow = {
    accountId: number;
    code: string;
    name: string;
    type: AccountType;
    debit: Piastres;
    credit: Piastres;
};
export type TrialBalance = {
    rows: TrialBalanceRow[];
    totalDebit: Piastres;
    totalCredit: Piastres;
};
export type NewAccount = {
    code: string;
    name: string;
    type: AccountType;
};
export type AccountChanges = {
    code?: string;
    name?: string;
};
