import { type IsoDate, type Piastres } from "./ledger";
/** Cash, bank and wallet accounts: the system ones, and any asset account the user adds in the 11xx cash and bank group. */
export type MoneyAccount = {
    id: number;
    code: string;
    name: string;
    balance: Piastres;
};
export type ExpenseInput = {
    date: IsoDate;
    /** An expense account from the chart. */
    expenseAccountId: number;
    /** Without VAT. */
    amount: Piastres;
    /** Input VAT on the bill, if any. */
    vat: Piastres;
    /** Paid from a money account now, or owed to a supplier. */
    paidFrom: {
        accountId: number;
    } | {
        supplierId: number;
    };
    memo: string;
};
export type Expense = {
    id: number;
    number: number;
    date: IsoDate;
    accountName: string;
    amount: Piastres;
    vat: Piastres;
    /** The money account or supplier's name. */
    paidFrom: string;
    memo: string;
    entryId: number;
    voided: boolean;
};
export type MoneyTransferInput = {
    date: IsoDate;
    fromAccountId: number;
    toAccountId: number;
    amount: Piastres;
    memo: string;
};
export type MoneyTransfer = {
    id: number;
    number: number;
    date: IsoDate;
    from: string;
    to: string;
    amount: Piastres;
    memo: string;
    entryId: number;
    voided: boolean;
};
export type PostedDocument = {
    id: number;
    number: number;
    entryId: number;
};
export type AccountLine = {
    lineId: number;
    entryId: number;
    date: IsoDate;
    memo: string;
    debit: Piastres;
    credit: Piastres;
    cleared: boolean;
};
export type Reconciliation = {
    /** Every posting to the account. */
    balance: Piastres;
    /** The lines ticked as on the bank statement. */
    cleared: Piastres;
    statement: Piastres;
    /** Statement less cleared: zero when the ticked lines match the statement. */
    difference: Piastres;
};
