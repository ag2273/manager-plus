import { type BusinessErrorCode } from "./errors";
import type { IsoDate, Piastres } from "./ledger";
/** One sheet of a spreadsheet or CSV file, every cell as text. */
export type ImportSheet = {
    name: string;
    rows: string[][];
};
export type ImportInput = {
    /** The date the opening stock and balances are posted on. */
    date: IsoDate;
    /** Where the opening stock goes. */
    warehouseId: number;
    sheets: ImportSheet[];
};
/** Why one row can't be imported; row numbers count from 1 as the spreadsheet shows them. */
export type ImportProblem = {
    sheet: string;
    row: number;
    column: string | null;
    code: BusinessErrorCode;
    value: string;
};
export type ImportReport = {
    items: number;
    stockLines: number;
    stockValue: Piastres;
    balances: number;
    newCustomers: number;
    newSuppliers: number;
    problems: ImportProblem[];
};
