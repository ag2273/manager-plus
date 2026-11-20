import type Database from "better-sqlite3";
import { assertIsoDate } from "./dates";
import { BusinessError } from "./errors";
import { type BasisPoints, type Quantity, vatRate } from "./items";
import { type IsoDate, type JournalLine, type Piastres, postJournalEntry } from "./ledger";
import { vatRegistered } from "./purchases";
import { requireOpenShift } from "./shifts";
import { findCustomer } from "./customers";
import {
  type UnitLine,
  accountByRole,
  activeWarehouse,
  assertQuantity,
  costOfIssue,
  insertMovement,
  toBaseQuantity,
} from "./stock";

/** A till line: the item, which unit was rung up, and how many (thousandths of that unit). */
export type SaleLineInput = UnitLine;
export type SaleLine = SaleLineInput & { unitPrice: Piastres; gross: Piastres; net: Piastres; vatRate: BasisPoints; vat: Piastres };
export type PricedSale = { lines: SaleLine[]; net: Piastres; vat: Piastres; total: Piastres };
export type PaymentMethod = "cash" | "card" | "wallet";
export const PAYMENT_METHODS: readonly PaymentMethod[] = ["cash", "card", "wallet"];
/** A tender at the till. Cash is what the customer handed over, before change. */
export type Payment = { method: PaymentMethod; amount: Piastres };
export type SaleInput = {
  date: IsoDate;
  warehouseId: number;
  lines: SaleLineInput[];
  payments: Payment[];
  /** Needed when part of the total is left on credit. */
  customerId?: number;
};
export type CashSaleInput = { date: IsoDate; warehouseId: number; lines: SaleLineInput[]; cashReceived: Piastres };
export type SaleResult = CashSaleResult;
export type CashSaleResult = {
  id: number;
  number: number;
  total: Piastres;
  change: Piastres;
  /** Items whose quantity on hand went below zero with this sale. */
  belowZero: number[];
};
export type Receipt = {
  id: number;
  number: number;
  date: IsoDate;
  /** When the sale was made, as an ISO timestamp in UTC. */
  at: string;
  warehouseId: number;
  net: Piastres;
  vat: Piastres;
  total: Piastres;
  cashReceived: Piastres;
  change: Piastres;
  /** What each tender paid; cash is after change. */
  payments: Payment[];
  /** The part of the total left on the customer's account. */
  onCredit: Piastres;
  customerId: number | null;
  soldBy: string;
  eta: { uuid: string; previousUuid: string; status: string };
  lines: (SaleLine & { nameAr: string })[];
};

const ONE_UNIT = 1000;
const WHOLE = 10_000;

/**
 * Prices till lines at the shelf price of the unit rung up. Shelf prices include VAT,
 * so per line: net = round(gross / (1 + rate)), half-up, and VAT = gross − net.
 */
export function priceSale(db: Database.Database, date: IsoDate, lines: SaleLineInput[]): PricedSale {
  assertIsoDate(date);
  const registered = vatRegistered(db);
  const unitOf = db.prepare(
    `SELECT u.sale_price AS price, i.tax_code_id AS taxCodeId
       FROM items i JOIN item_units u ON u.item_id = i.id AND u.kind = ?
      WHERE i.id = ?`,
  );
  const priced = lines.map((line): SaleLine => {
    assertQuantity(line.quantity);
    const unit = unitOf.get(line.unit, line.itemId) as { price: number; taxCodeId: number } | undefined;
    if (!unit) {
      const exists = db.prepare("SELECT 1 FROM items WHERE id = ?").get(line.itemId);
      if (!exists) throw new BusinessError("item_not_found", `No item with id ${line.itemId}`);
      throw new BusinessError("item_has_no_pack", `Item ${line.itemId} has no pack unit`);
    }
    const gross = Math.round((line.quantity * unit.price) / ONE_UNIT);
    const rate = vatRate(db, unit.taxCodeId, date, registered);
    const net = Math.round((gross * WHOLE) / (WHOLE + rate));
    return { itemId: line.itemId, unit: line.unit, quantity: line.quantity, unitPrice: unit.price, gross, net, vatRate: rate, vat: gross - net };
  });
  const net = priced.reduce((t, l) => t + l.net, 0);
  const vat = priced.reduce((t, l) => t + l.vat, 0);
  return { lines: priced, net, vat, total: net + vat };
}

function nextReceiptNumber(db: Database.Database): number {
  return (db.prepare("SELECT COALESCE(MAX(number), 0) + 1 AS n FROM sales_receipts").get() as { n: number }).n;
}

/** Tenders per method, the change from cash, and what is left on credit. */
function settle(payments: Payment[], total: Piastres) {
  const paid: Record<PaymentMethod, Piastres> = { cash: 0, card: 0, wallet: 0 };
  for (const p of payments) {
    if (!PAYMENT_METHODS.includes(p.method)) throw new BusinessError("payment_method_invalid", `Unknown payment method ${p.method}`);
    if (!Number.isSafeInteger(p.amount) || p.amount < 0) {
      throw new BusinessError("line_amount_invalid", `Payment ${p.amount} is not whole piastres`);
    }
    paid[p.method] += p.amount;
  }
  const tendered = paid.cash + paid.card + paid.wallet;
  const change = Math.max(0, tendered - total);
  if (change > paid.cash) throw new BusinessError("change_without_cash", "Only cash can give change");
  return { applied: { ...paid, cash: paid.cash - change }, cashReceived: paid.cash, change, onCredit: Math.max(0, total - tendered) };
}

/**
 * A sale at the till: Dr each tender's account (cash after change, card clearing,
 * wallet) and Receivables for any unpaid part; Cr Sales (net) and Output VAT;
 * Dr Cost of goods sold, Cr Stock at average cost. Selling more than is on hand is
 * allowed and reported in `belowZero`.
 */
export function postSale(db: Database.Database, input: SaleInput, userId: number): SaleResult {
  const shift = requireOpenShift(db, userId);
  activeWarehouse(db, input.warehouseId);
  if (input.lines.length === 0) throw new BusinessError("invoice_needs_lines", "A sale needs at least one line");
  const priced = priceSale(db, input.date, input.lines);
  const { applied, cashReceived, change, onCredit } = settle(input.payments, priced.total);
  const customerId = input.customerId;
  if (onCredit > 0 && customerId === undefined) {
    throw new BusinessError("payment_short", `Paid ${priced.total - onCredit} of ${priced.total}, with no customer to owe the rest`);
  }
  if (customerId !== undefined) {
    const customer = findCustomer(db, customerId);
    if (!customer.active) throw new BusinessError("customer_inactive", `Customer ${customer.name} is stopped`);
  }

  // Cost each line in order, so two lines of the same item draw down stock one after the other.
  const taken = new Map<number, { quantity: Quantity; value: Piastres }>();
  const outs = priced.lines.map((line) => {
    const base = toBaseQuantity(db, line);
    const before = taken.get(line.itemId) ?? { quantity: 0, value: 0 };
    const cost = costOfIssue(db, line.itemId, base, before);
    taken.set(line.itemId, { quantity: before.quantity + base, value: before.value + cost });
    return { line, base, cost };
  });
  const totalCost = outs.reduce((t, o) => t + o.cost, 0);

  const number = nextReceiptNumber(db);
  const journal: JournalLine[] = [];
  const tenderAccount: Record<PaymentMethod, string> = { cash: "cash_drawer", card: "card_clearing", wallet: "wallet" };
  for (const method of PAYMENT_METHODS) {
    if (applied[method] > 0) journal.push({ accountId: accountByRole(db, tenderAccount[method]), debit: applied[method] });
  }
  if (onCredit > 0 && customerId !== undefined) {
    journal.push({ accountId: accountByRole(db, "receivables"), debit: onCredit, customerId });
  }
  if (priced.net > 0) journal.push({ accountId: accountByRole(db, "sales"), credit: priced.net });
  if (priced.vat > 0) journal.push({ accountId: accountByRole(db, "output_vat"), credit: priced.vat });
  if (totalCost > 0) {
    journal.push({ accountId: accountByRole(db, "cost_of_goods_sold"), debit: totalCost });
    journal.push({ accountId: accountByRole(db, "stock"), credit: totalCost });
  }
  const entryId = postJournalEntry(db, { date: input.date, memo: `إيصال بيع رقم ${number}`, lines: journal }, "sale");
  const id = Number(
    db
      .prepare(
        `INSERT INTO sales_receipts (number, date, at, warehouse_id, entry_id, user_id, cash_received, shift_id, customer_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        number,
        input.date,
        new Date().toISOString(),
        input.warehouseId,
        entryId,
        userId,
        cashReceived,
        shift.id,
        input.customerId ?? null,
      ).lastInsertRowid,
  );
  const insertPayment = db.prepare("INSERT INTO sales_receipt_payments (receipt_id, method, amount) VALUES (?, ?, ?)");
  for (const method of PAYMENT_METHODS) if (applied[method] > 0) insertPayment.run(id, method, applied[method]);
  const insertLine = db.prepare(
    `INSERT INTO sales_receipt_lines (receipt_id, item_id, unit, quantity, unit_price, gross, net, vat_rate, vat, cost)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const { line: l, base, cost } of outs) {
    insertLine.run(id, l.itemId, l.unit, l.quantity, l.unitPrice, l.gross, l.net, l.vatRate, l.vat, cost);
    insertMovement(db, {
      date: input.date,
      itemId: l.itemId,
      warehouseId: input.warehouseId,
      quantity: -base,
      value: -cost,
      source: "sale",
      sourceId: id,
    });
  }

  const held = db.prepare("SELECT COALESCE(SUM(quantity), 0) AS q FROM stock_movements WHERE item_id = ? AND warehouse_id = ?");
  const belowZero = [...taken.keys()].filter((itemId) => (held.get(itemId, input.warehouseId) as { q: number }).q < 0);
  return { id, number, total: priced.total, change, belowZero };
}

/** A sale paid entirely in cash. */
export function postCashSale(db: Database.Database, input: CashSaleInput, userId: number): CashSaleResult {
  const { cashReceived, ...rest } = input;
  return postSale(db, { ...rest, payments: [{ method: "cash", amount: cashReceived }] }, userId);
}

type ReceiptRow = {
  id: number;
  number: number;
  date: IsoDate;
  at: string;
  warehouseId: number;
  cashReceived: number;
  customerId: number | null;
  soldBy: string;
  etaUuid: string;
  etaPreviousUuid: string;
  etaStatus: string;
};

/** Receipts, newest first. */
export function listReceipts(db: Database.Database, limit = 200): Receipt[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.number, r.date, r.at, r.warehouse_id AS warehouseId, r.cash_received AS cashReceived,
              r.customer_id AS customerId, u.name AS soldBy, r.eta_uuid AS etaUuid, r.eta_previous_uuid AS etaPreviousUuid, r.eta_status AS etaStatus
         FROM sales_receipts r JOIN users u ON u.id = r.user_id
        ORDER BY r.number DESC LIMIT ?`,
    )
    .all(limit) as ReceiptRow[];
  const lines = db.prepare(
    `SELECT l.item_id AS itemId, i.name_ar AS nameAr, l.unit, l.quantity, l.unit_price AS unitPrice,
            l.gross, l.net, l.vat_rate AS vatRate, l.vat
       FROM sales_receipt_lines l JOIN items i ON i.id = l.item_id
      WHERE l.receipt_id = ? ORDER BY l.id`,
  );
  const payments = db.prepare("SELECT method, amount FROM sales_receipt_payments WHERE receipt_id = ? ORDER BY id");
  return rows.map((r) => {
    const ls = lines.all(r.id) as Receipt["lines"];
    const paid = payments.all(r.id) as Payment[];
    const paidTotal = paid.reduce((t, p) => t + p.amount, 0);
    const cashApplied = paid.find((p) => p.method === "cash")?.amount ?? 0;
    const net = ls.reduce((t, l) => t + l.net, 0);
    const vat = ls.reduce((t, l) => t + l.vat, 0);
    return {
      id: r.id,
      number: r.number,
      date: r.date,
      at: r.at,
      warehouseId: r.warehouseId,
      net,
      vat,
      total: net + vat,
      cashReceived: r.cashReceived,
      change: r.cashReceived - cashApplied,
      payments: paid,
      onCredit: net + vat - paidTotal,
      customerId: r.customerId,
      soldBy: r.soldBy,
      eta: { uuid: r.etaUuid, previousUuid: r.etaPreviousUuid, status: r.etaStatus },
      lines: ls,
    };
  });
}
