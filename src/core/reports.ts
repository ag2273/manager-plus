import type Database from "better-sqlite3";
import type { AccountType } from "./chart-of-accounts";
import { assertIsoDate } from "./dates";
import { BusinessError } from "./errors";
import { lowStock } from "./inventory";
import type { Quantity } from "./items";
import type { IsoDate, Piastres } from "./ledger";
import { openShiftOf, zReport } from "./shifts";

export type ReportRow = { accountId: number; code: string; name: string; amount: Piastres };
export type ProfitAndLoss = { from: IsoDate; to: IsoDate; income: ReportRow[]; expenses: ReportRow[]; totalIncome: Piastres; totalExpenses: Piastres; netProfit: Piastres };
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
export type LedgerLine = { entryId: number; date: IsoDate; memo: string; debit: Piastres; credit: Piastres; balance: Piastres };
export type GeneralLedger = { accountId: number; code: string; name: string; from: IsoDate; to: IsoDate; opening: Piastres; lines: LedgerLine[]; closing: Piastres };
export type EntryDetail = {
  id: number;
  date: IsoDate;
  memo: string;
  /** The kind of document that posted it: sale, sales_invoice, purchase, expense, journal, … */
  kind: string;
  voided: boolean;
  lines: { accountId: number; code: string; name: string; debit: Piastres; credit: Piastres; party: string | null }[];
};
export type ItemSalesRow = { itemId: number; nameAr: string; quantity: Quantity; net: Piastres; cost: Piastres; grossProfit: Piastres };
export type DaySalesRow = { date: IsoDate; documents: number; net: Piastres; vat: Piastres; total: Piastres };
export type MethodSalesRow = { method: "cash" | "card" | "wallet" | "credit"; total: Piastres };
export type SalesDocument = { kind: "sale" | "sales_invoice" | "sale_return" | "credit_note"; number: number; date: IsoDate; net: Piastres; vat: Piastres; total: Piastres; entryId: number };
export type StockRow = { itemId: number; nameAr: string; quantity: Quantity; value: Piastres };
export type StockReport = { asOf: IsoDate; rows: StockRow[]; totalValue: Piastres };
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

function range(from: IsoDate, to: IsoDate): void {
  assertIsoDate(from);
  assertIsoDate(to);
  if (from > to) throw new BusinessError("date_range_invalid", `${from} is after ${to}`);
}

function sums(db: Database.Database, types: AccountType[], where: string, args: unknown[]): (ReportRow & { type: AccountType })[] {
  return db
    .prepare(
      `SELECT a.id AS accountId, a.code, a.name, a.type, SUM(l.debit) - SUM(l.credit) AS amount
         FROM ledger_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
        WHERE a.type IN (${types.map(() => "?").join(", ")}) AND ${where}
        GROUP BY a.id HAVING SUM(l.debit) - SUM(l.credit) <> 0 ORDER BY a.code`,
    )
    .all(...types, ...args) as (ReportRow & { type: AccountType })[];
}

const total = (rows: ReportRow[]) => rows.reduce((t, r) => t + r.amount, 0);
const plain = ({ accountId, code, name, amount }: ReportRow): ReportRow => ({ accountId, code, name, amount });

export function profitAndLoss(db: Database.Database, from: IsoDate, to: IsoDate): ProfitAndLoss {
  range(from, to);
  const rows = sums(db, ["income", "expense"], "e.date BETWEEN ? AND ?", [from, to]);
  const income = rows.filter((r) => r.type === "income").map((r) => plain({ ...r, amount: -r.amount }));
  const expenses = rows.filter((r) => r.type === "expense").map(plain);
  const totalIncome = total(income);
  const totalExpenses = total(expenses);
  return { from, to, income, expenses, totalIncome, totalExpenses, netProfit: totalIncome - totalExpenses };
}

export function balanceSheet(db: Database.Database, asOf: IsoDate): BalanceSheet {
  assertIsoDate(asOf);
  const rows = sums(db, ["asset", "liability", "equity", "income", "expense"], "e.date <= ?", [asOf]);
  const assets = rows.filter((r) => r.type === "asset").map(plain);
  const liabilities = rows.filter((r) => r.type === "liability").map((r) => plain({ ...r, amount: -r.amount }));
  const equity = rows.filter((r) => r.type === "equity").map((r) => plain({ ...r, amount: -r.amount }));
  const profit = -rows.filter((r) => r.type === "income" || r.type === "expense").reduce((t, r) => t + r.amount, 0);
  return { asOf, assets, liabilities, equity, profit, totalAssets: total(assets), totalLiabilitiesAndEquity: total(liabilities) + total(equity) + profit };
}

export function generalLedger(db: Database.Database, accountId: number, from: IsoDate, to: IsoDate): GeneralLedger {
  range(from, to);
  const account = db.prepare("SELECT id, code, name FROM accounts WHERE id = ?").get(accountId) as { id: number; code: string; name: string } | undefined;
  if (!account) throw new BusinessError("account_not_found", `No account with id ${accountId}`);
  const opening = (
    db
      .prepare("SELECT COALESCE(SUM(l.debit) - SUM(l.credit), 0) AS b FROM ledger_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_id = ? AND e.date < ?")
      .get(accountId, from) as { b: number }
  ).b;
  let balance = opening;
  const lines = (
    db
      .prepare(
        `SELECT e.id AS entryId, e.date, e.memo, l.debit, l.credit FROM ledger_lines l JOIN journal_entries e ON e.id = l.entry_id
          WHERE l.account_id = ? AND e.date BETWEEN ? AND ? ORDER BY e.date, e.id, l.id`,
      )
      .all(accountId, from, to) as Omit<LedgerLine, "balance">[]
  ).map((l) => {
    balance += l.debit - l.credit;
    return { ...l, balance };
  });
  return { accountId, code: account.code, name: account.name, from, to, opening, lines, closing: balance };
}

/** One journal entry with its lines: where every report figure drills down to. */
export function journalEntry(db: Database.Database, entryId: number): EntryDetail {
  const entry = db.prepare("SELECT id, date, memo, kind, voided_by IS NOT NULL AS voided FROM journal_entries WHERE id = ?").get(entryId) as
    | (Omit<EntryDetail, "lines" | "voided"> & { voided: number })
    | undefined;
  if (!entry) throw new BusinessError("entry_not_found", `No journal entry with id ${entryId}`);
  const lines = db
    .prepare(
      `SELECT a.id AS accountId, a.code, a.name, l.debit, l.credit, COALESCE(c.name, s.name) AS party
         FROM ledger_lines l JOIN accounts a ON a.id = l.account_id
         LEFT JOIN customers c ON c.id = l.customer_id LEFT JOIN suppliers s ON s.id = l.supplier_id
        WHERE l.entry_id = ? ORDER BY l.id`,
    )
    .all(entryId) as EntryDetail["lines"];
  return { ...entry, voided: entry.voided === 1, lines };
}

/**
 * Every sales line in the period with its base quantity, net and cost: till sales and invoices as
 * they are, returns and credit notes negative.
 */
const SALES_LINES = `
  SELECT r.date, l.item_id AS itemId, l.quantity * u.size / 1000 AS quantity, l.net, l.cost
    FROM sales_receipt_lines l JOIN sales_receipts r ON r.id = l.receipt_id JOIN item_units u ON u.item_id = l.item_id AND u.kind = l.unit
  UNION ALL
  SELECT i.date, l.item_id, l.quantity * u.size / 1000, l.net, l.cost
    FROM sales_invoice_lines l JOIN sales_invoices i ON i.id = l.invoice_id JOIN item_units u ON u.item_id = l.item_id AND u.kind = l.unit
  UNION ALL
  SELECT x.date, o.item_id, -(l.quantity * u.size / 1000), -l.net, -l.cost
    FROM sales_return_lines l JOIN sales_returns x ON x.id = l.return_id JOIN sales_receipt_lines o ON o.id = l.receipt_line_id
    JOIN item_units u ON u.item_id = o.item_id AND u.kind = o.unit
  UNION ALL
  SELECT n.date, o.item_id, -(l.quantity * u.size / 1000), -l.net, -l.cost
    FROM credit_note_lines l JOIN credit_notes n ON n.id = l.note_id JOIN sales_invoice_lines o ON o.id = l.invoice_line_id
    JOIN item_units u ON u.item_id = o.item_id AND u.kind = o.unit`;

export function salesByItem(db: Database.Database, from: IsoDate, to: IsoDate): ItemSalesRow[] {
  range(from, to);
  return db
    .prepare(
      `SELECT s.itemId, i.name_ar AS nameAr, SUM(s.quantity) AS quantity, SUM(s.net) AS net, SUM(s.cost) AS cost, SUM(s.net) - SUM(s.cost) AS grossProfit
         FROM (${SALES_LINES}) s JOIN items i ON i.id = s.itemId
        WHERE s.date BETWEEN ? AND ? GROUP BY s.itemId ORDER BY SUM(s.net) DESC, i.name_ar`,
    )
    .all(from, to) as ItemSalesRow[];
}

/** Sales documents in the period, newest first: what the sales-by-day and by-method figures drill down to. */
export function salesDocuments(db: Database.Database, from: IsoDate, to: IsoDate): SalesDocument[] {
  range(from, to);
  return db
    .prepare(
      `SELECT * FROM (
         SELECT 'sale' AS kind, r.number, r.date, SUM(l.net) AS net, SUM(l.vat) AS vat, SUM(l.net + l.vat) AS total, r.entry_id AS entryId
           FROM sales_receipts r JOIN sales_receipt_lines l ON l.receipt_id = r.id GROUP BY r.id
         UNION ALL
         SELECT 'sales_invoice', i.number, i.date, SUM(l.net), SUM(l.vat), SUM(l.net + l.vat), i.entry_id
           FROM sales_invoices i JOIN sales_invoice_lines l ON l.invoice_id = i.id GROUP BY i.id
         UNION ALL
         SELECT 'sale_return', x.number, x.date, -SUM(l.net), -SUM(l.vat), -SUM(l.net + l.vat), x.entry_id
           FROM sales_returns x JOIN sales_return_lines l ON l.return_id = x.id GROUP BY x.id
         UNION ALL
         SELECT 'credit_note', n.number, n.date, -SUM(l.net), -SUM(l.vat), -SUM(l.net + l.vat), n.entry_id
           FROM credit_notes n JOIN credit_note_lines l ON l.note_id = n.id GROUP BY n.id
       ) WHERE date BETWEEN ? AND ? ORDER BY date DESC, entryId DESC`,
    )
    .all(from, to) as SalesDocument[];
}

export function salesByDay(db: Database.Database, from: IsoDate, to: IsoDate): DaySalesRow[] {
  const byDay = new Map<string, DaySalesRow>();
  for (const d of salesDocuments(db, from, to)) {
    const row = byDay.get(d.date) ?? { date: d.date, documents: 0, net: 0, vat: 0, total: 0 };
    row.documents += 1;
    row.net += d.net;
    row.vat += d.vat;
    row.total += d.total;
    byDay.set(d.date, row);
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Till takings by method (cash after change, less cash refunds), and what sales left on customers' accounts. */
export function salesByPaymentMethod(db: Database.Database, from: IsoDate, to: IsoDate): MethodSalesRow[] {
  range(from, to);
  const methods = db
    .prepare(
      `SELECT p.method, SUM(p.amount) AS total FROM sales_receipt_payments p JOIN sales_receipts r ON r.id = p.receipt_id
        WHERE r.date BETWEEN ? AND ? GROUP BY p.method`,
    )
    .all(from, to) as { method: "cash" | "card" | "wallet"; total: number }[];
  const refunds = (
    db
      .prepare(
        `SELECT x.refund, COALESCE(SUM(l.amount), 0) AS t FROM sales_returns x JOIN sales_return_lines l ON l.return_id = x.id
          WHERE x.date BETWEEN ? AND ? GROUP BY x.refund`,
      )
      .all(from, to) as { refund: "cash" | "account"; t: number }[]
  ).reduce((m, r) => ({ ...m, [r.refund]: r.t }), { cash: 0, account: 0 } as Record<string, number>);
  // What the receipts and invoices left unpaid, less credit notes.
  const docs = salesDocuments(db, from, to);
  const tillSales = docs.filter((d) => d.kind === "sale").reduce((t, d) => t + d.total, 0);
  const invoices = docs.filter((d) => d.kind === "sales_invoice" || d.kind === "credit_note").reduce((t, d) => t + d.total, 0);
  const paid = methods.reduce((t, m) => t + m.total, 0);
  const by = (m: string) => methods.find((x) => x.method === m)?.total ?? 0;
  return [
    { method: "cash", total: by("cash") - refunds.cash! },
    { method: "card", total: by("card") },
    { method: "wallet", total: by("wallet") },
    { method: "credit", total: tillSales - paid + invoices - refunds.account! },
  ];
}

/** Each item's quantity and value at the end of a date, from its movements. */
export function stockAt(db: Database.Database, asOf: IsoDate): StockReport {
  assertIsoDate(asOf);
  const rows = db
    .prepare(
      `SELECT m.item_id AS itemId, i.name_ar AS nameAr, SUM(m.quantity) AS quantity, SUM(m.value) AS value
         FROM stock_movements m JOIN items i ON i.id = m.item_id WHERE m.date <= ?
        GROUP BY m.item_id HAVING SUM(m.quantity) <> 0 OR SUM(m.value) <> 0 ORDER BY i.name_ar`,
    )
    .all(asOf) as StockRow[];
  return { asOf, rows, totalValue: rows.reduce((t, r) => t + r.value, 0) };
}

export function dashboard(db: Database.Database, date: IsoDate, userId: number): Dashboard {
  assertIsoDate(date);
  const docs = salesDocuments(db, date, date);
  const items = salesByItem(db, date, date);
  const shift = openShiftOf(db, userId);
  return {
    date,
    sales: docs.reduce((t, d) => t + d.total, 0),
    grossProfit: items.reduce((t, i) => t + i.grossProfit, 0),
    cashExpected: shift ? zReport(db, shift.id).expectedCash : null,
    lowStock: lowStock(db).length,
  };
}
