import type Database from "better-sqlite3";
import { BALANCE_COLUMNS, BALANCE_TYPES, type ImportColumn, ITEM_COLUMNS, TAX_WORDS } from "../shared/import-columns";
import { parseMoney } from "../shared/money";
import { parseQuantity } from "../shared/quantity";
import { addCustomer } from "./customers";
import { assertIsoDate } from "./dates";
import { BusinessError, type BusinessErrorCode } from "./errors";
import { addItem, type ItemInput } from "./items";
import { type IsoDate, type JournalLine, type Piastres, postOpeningBalances } from "./ledger";
import { addSupplier } from "./purchases";
import { type OpeningStockLine, accountByRole, activeWarehouse, postOpeningStock } from "./stock";

/** One sheet of a spreadsheet or CSV file, every cell as text. */
export type ImportSheet = { name: string; rows: string[][] };
export type ImportInput = {
  /** The date the opening stock and balances are posted on. */
  date: IsoDate;
  /** Where the opening stock goes. */
  warehouseId: number;
  sheets: ImportSheet[];
};
/** Why one row can't be imported; row numbers count from 1 as the spreadsheet shows them. */
export type ImportProblem = { sheet: string; row: number; column: string | null; code: BusinessErrorCode; value: string };
export type ImportReport = {
  items: number;
  stockLines: number;
  stockValue: Piastres;
  balances: number;
  newCustomers: number;
  newSuppliers: number;
  problems: ImportProblem[];
};

/** A value that can't be read stops the row with this code, against this column. */
class CellError extends Error {
  constructor(
    readonly code: BusinessErrorCode,
    readonly column: string,
    readonly value: string,
  ) {
    super(code);
  }
}

/** Which column of the template each core error points at, so a problem names the cell to fix. */
const ERROR_COLUMN: Partial<Record<string, string>> = {
  item_name_required: "nameAr",
  item_unit_required: "baseUnit",
  item_code_taken: "code",
  barcode_taken: "barcode",
  pack_size_invalid: "packSize",
};

const norm = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");

/** Finds the header row (the first that isn't blank) and where each known column sits in it. */
function header<K extends string>(sheet: ImportSheet, columns: ImportColumn<K>[]): { at: number; index: Map<K, number> } | null {
  const at = sheet.rows.findIndex((r) => r.some((c) => c.trim() !== ""));
  if (at < 0) return null;
  const cells = sheet.rows[at]!.map(norm);
  const index = new Map<K, number>();
  for (const c of columns) {
    const i = cells.findIndex((cell) => cell === norm(c.ar) || cell === norm(c.en));
    if (i >= 0) index.set(c.key, i);
  }
  return index.has(columns[0]!.key) ? { at, index } : null;
}

/** Reads one row's cells by column key, with typed readers that throw a CellError. */
function reader<K extends string>(row: string[], index: Map<K, number>, columns: ImportColumn<K>[]) {
  const text = (key: K) => (index.has(key) ? (row[index.get(key)!] ?? "").trim() : "");
  const required = (key: K) => {
    const value = text(key);
    if (value === "" && columns.find((c) => c.key === key)?.required) throw new CellError("import_value_required", key, value);
    return value;
  };
  const money = (key: K, code: BusinessErrorCode = "price_invalid"): Piastres | null => {
    const value = text(key);
    if (value === "") return null;
    const amount = parseMoney(value);
    if (amount === null) throw new CellError(code, key, value);
    return amount;
  };
  const quantity = (key: K): number | null => {
    const value = text(key);
    if (value === "") return null;
    const q = parseQuantity(value);
    if (q === null) throw new CellError("quantity_invalid", key, value);
    return q;
  };
  return { text, required, money, quantity };
}

const blank = (row: string[]) => row.every((c) => c.trim() === "");

/**
 * Imports items with their opening stock, and opening balances, from spreadsheet rows. Each row
 * goes through the same commands as typing it in; a dry run, or any row that fails, saves nothing.
 */
export function importData(db: Database.Database, input: ImportInput, dryRun: boolean): ImportReport {
  assertIsoDate(input.date);
  activeWarehouse(db, input.warehouseId);
  const report: ImportReport = { items: 0, stockLines: 0, stockValue: 0, balances: 0, newCustomers: 0, newSuppliers: 0, problems: [] };
  const problem = (sheet: string, row: number, column: string | null, code: BusinessErrorCode, value = "") =>
    report.problems.push({ sheet, row, column, code, value });
  const taxCodes = new Map((db.prepare("SELECT kind, id FROM tax_codes").all() as { kind: string; id: number }[]).map((t) => [t.kind, t.id]));
  const stock: OpeningStockLine[] = [];
  const balances: JournalLine[] = [];
  let recognised = 0;

  /** Runs one row; a core refusal or unreadable cell becomes a problem against that row. */
  const attempt = (sheet: string, row: number, work: () => void) => {
    // Each row is its own savepoint, so a refused row leaves nothing half-written for the rows after it.
    try {
      db.transaction(work)();
    } catch (error) {
      if (error instanceof CellError) problem(sheet, row, error.column, error.code, error.value);
      else if (error instanceof BusinessError) problem(sheet, row, ERROR_COLUMN[error.code] ?? null, error.code);
      else throw error;
    }
  };

  const ROLLBACK = new Error("import rollback");
  try {
    db.transaction(() => {
      for (const sheet of input.sheets) {
        const items = header(sheet, ITEM_COLUMNS);
        const accounts = items ? null : header(sheet, BALANCE_COLUMNS);
        const found = items ?? accounts;
        if (!found) continue;
        recognised++;
        const columns: ImportColumn<string>[] = items ? ITEM_COLUMNS : BALANCE_COLUMNS;
        const missing = columns.filter((c) => c.required && !found.index.has(c.key as never));
        for (const c of missing) problem(sheet.name, found.at + 1, c.key, "import_column_missing", c.ar);
        if (missing.length > 0) continue;
        for (let r = found.at + 1; r < sheet.rows.length; r++) {
          const row = sheet.rows[r]!;
          if (blank(row)) continue;
          if (items) attempt(sheet.name, r + 1, () => importItem(row, items.index));
          else attempt(sheet.name, r + 1, () => importBalance(row, accounts!.index));
        }
      }
      if (recognised === 0) problem("", 0, null, "import_nothing");
      if (report.problems.length === 0 && stock.length > 0) postOpeningStock(db, input.date, input.warehouseId, stock);
      if (report.problems.length === 0 && balances.length > 0) postOpeningBalances(db, input.date, balances);
      if (dryRun || report.problems.length > 0) throw ROLLBACK;
    })();
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
  return report;

  function importItem(row: string[], index: Map<(typeof ITEM_COLUMNS)[number]["key"], number>) {
    const cell = reader(row, index, ITEM_COLUMNS);
    const taxWord = norm(cell.text("tax"));
    const kind = TAX_WORDS[taxWord];
    if (!kind) throw new CellError("tax_code_unknown", "tax", cell.text("tax"));
    const salePrice = cell.money("salePrice");
    if (salePrice === null) throw new CellError("import_value_required", "salePrice", "");
    const packName = cell.text("packName");
    const packSize = cell.quantity("packSize");
    const packPrice = cell.money("packPrice");
    const item: ItemInput = {
      nameAr: cell.required("nameAr"),
      nameEn: cell.text("nameEn"),
      code: cell.text("code"),
      baseUnit: cell.required("baseUnit"),
      barcode: cell.text("barcode"),
      salePrice,
      wholesalePrice: cell.money("wholesalePrice"),
      taxCodeId: taxCodes.get(kind)!,
      pack:
        packName === ""
          ? null
          : {
              name: packName,
              size: packSize ?? 0,
              barcode: cell.text("packBarcode"),
              salePrice: packPrice ?? Math.round((salePrice * (packSize ?? 0)) / 1000),
            },
    };
    const quantity = cell.quantity("openingQuantity");
    const unitCost = cell.money("unitCost");
    if (quantity !== null && quantity > 0 && unitCost === null) throw new CellError("cost_required", "unitCost", "");
    const itemId = addItem(db, item);
    report.items++;
    if (quantity !== null && quantity > 0) {
      stock.push({ itemId, quantity, unitCost: unitCost! });
      report.stockLines++;
      report.stockValue += Math.round((quantity * unitCost!) / 1000);
    }
  }

  function importBalance(row: string[], index: Map<(typeof BALANCE_COLUMNS)[number]["key"], number>) {
    const cell = reader(row, index, BALANCE_COLUMNS);
    const typeWord = cell.required("type");
    const type = BALANCE_TYPES[norm(typeWord)];
    if (!type) throw new CellError("party_type_unknown", "type", typeWord);
    const name = cell.required("name");
    const debit = cell.money("debit", "line_amount_invalid") ?? 0;
    const credit = cell.money("credit", "line_amount_invalid") ?? 0;
    if (debit > 0 === credit > 0) throw new CellError("line_amount_invalid", debit > 0 ? "credit" : "debit", "");
    const amounts = debit > 0 ? { debit } : { credit };
    if (type === "account") {
      const account = db
        .prepare("SELECT id, role, active FROM accounts WHERE code = ? OR name = ? ORDER BY code = ? DESC LIMIT 1")
        .get(name, name, name) as { id: number; role: string | null; active: number } | undefined;
      if (!account) throw new CellError("account_not_found", "name", name);
      if (account.role && ["opening_balances", "receivables", "payables", "stock"].includes(account.role)) {
        throw new CellError("account_not_allowed", "name", name);
      }
      balances.push({ accountId: account.id, ...amounts });
    } else if (type === "customer") {
      let customer = (db.prepare("SELECT id FROM customers WHERE name = ?").get(name) as { id: number } | undefined)?.id;
      if (customer === undefined) {
        customer = addCustomer(db, { name, phone: "", taxRegistrationNumber: "" });
        report.newCustomers++;
      }
      balances.push({ accountId: accountByRole(db, "receivables"), customerId: customer, ...amounts });
    } else {
      const found = db.prepare("SELECT id, currency FROM suppliers WHERE name = ?").get(name) as { id: number; currency: string } | undefined;
      if (found && found.currency !== "EGP") throw new CellError("supplier_not_egp", "name", name);
      let supplier = found?.id;
      if (supplier === undefined) {
        supplier = addSupplier(db, { name, phone: "", taxRegistrationNumber: "" });
        report.newSuppliers++;
      }
      balances.push({ accountId: accountByRole(db, "payables"), supplierId: supplier, ...amounts });
    }
    report.balances++;
  }
}
