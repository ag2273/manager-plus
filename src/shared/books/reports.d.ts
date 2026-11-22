import type { Quantity } from "./items";
import type { IsoDate, Piastres } from "./ledger";
export type ReportRow = {
    accountId: number;
    code: string;
    name: string;
    amount: Piastres;
};
export type ProfitAndLoss = {
    from: IsoDate;
    to: IsoDate;
    income: ReportRow[];
    expenses: ReportRow[];
    totalIncome: Piastres;
    totalExpenses: Piastres;
    netProfit: Piastres;
};
export type BalanceSheet = {
    asOf: IsoDate;
    assets: ReportRow[];
    liabilities: ReportRow[];
    equity: ReportRow[];
    /** Income less expenses to date, not yet closed into retained earnings. */
    profit: Piastres;
    totalAssets: Piastres;
    /** Liabilities, equity and profit: equal to the assets when the books balance. */
    totalLiabilitiesAndEquity: Piastres;
};
export type LedgerLine = {
    entryId: number;
    date: IsoDate;
    memo: string;
    debit: Piastres;
    credit: Piastres;
    balance: Piastres;
};
export type GeneralLedger = {
    accountId: number;
    code: string;
    name: string;
    from: IsoDate;
    to: IsoDate;
    opening: Piastres;
    lines: LedgerLine[];
    closing: Piastres;
};
export type EntryDetail = {
    id: number;
    date: IsoDate;
    memo: string;
    /** The kind of document that posted it: sale, sales_invoice, purchase, expense, journal, … */
    kind: string;
    voided: boolean;
    lines: {
        accountId: number;
        code: string;
        name: string;
        debit: Piastres;
        credit: Piastres;
        party: string | null;
    }[];
};
export type ItemSalesRow = {
    itemId: number;
    nameAr: string;
    quantity: Quantity;
    net: Piastres;
    cost: Piastres;
    grossProfit: Piastres;
};
export type DaySalesRow = {
    date: IsoDate;
    documents: number;
    net: Piastres;
    vat: Piastres;
    total: Piastres;
};
export type MethodSalesRow = {
    method: "cash" | "card" | "wallet" | "credit";
    total: Piastres;
};
export type SalesDocument = {
    kind: "sale" | "sales_invoice" | "sale_return" | "credit_note";
    number: number;
    date: IsoDate;
    net: Piastres;
    vat: Piastres;
    total: Piastres;
    entryId: number;
};
export type StockRow = {
    itemId: number;
    nameAr: string;
    quantity: Quantity;
    value: Piastres;
};
export type StockReport = {
    asOf: IsoDate;
    rows: StockRow[];
    totalValue: Piastres;
};
export type Dashboard = {
    date: IsoDate;
    /** Sales with VAT, less returns and credit notes. */
    sales: Piastres;
    /** Net sales less their cost. */
    grossProfit: Piastres;
    /** In the signed-in user's open shift; null with no shift open. */
    cashExpected: Piastres | null;
    lowStock: number;
};
