import type Database from "better-sqlite3";
import { assertIsoDate } from "./dates";
import { BusinessError } from "./errors";
import { type BasisPoints, type Quantity, vatRate } from "./items";
import { type IsoDate, type JournalLine, type Piastres, postJournalEntry } from "./ledger";
import { vatRegistered } from "./purchases";
import { requireOpenShift } from "./shifts";
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
export type CashSaleInput = { date: IsoDate; warehouseId: number; lines: SaleLineInput[]; cashReceived: Piastres };
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

/**
 * A cash sale at the till: Dr Cash drawer; Cr Sales (net) and Output VAT; Dr Cost of
 * goods sold, Cr Stock at average cost. Selling more than is on hand is allowed and
 * reported in `belowZero`.
 */
export function postCashSale(db: Database.Database, input: CashSaleInput, userId: number): CashSaleResult {
  const shift = requireOpenShift(db, userId);
  activeWarehouse(db, input.warehouseId);
  if (input.lines.length === 0) throw new BusinessError("invoice_needs_lines", "A sale needs at least one line");
  const priced = priceSale(db, input.date, input.lines);
  if (!Number.isSafeInteger(input.cashReceived) || input.cashReceived < priced.total) {
    throw new BusinessError("payment_short", `Cash received ${input.cashReceived} is less than the total ${priced.total}`);
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
  const journal: JournalLine[] = [{ accountId: accountByRole(db, "cash_drawer"), debit: priced.total }];
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
        `INSERT INTO sales_receipts (number, date, at, warehouse_id, entry_id, user_id, cash_received, shift_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(number, input.date, new Date().toISOString(), input.warehouseId, entryId, userId, input.cashReceived, shift.id)
      .lastInsertRowid,
  );
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
  return { id, number, total: priced.total, change: input.cashReceived - priced.total, belowZero };
}

type ReceiptRow = {
  id: number;
  number: number;
  date: IsoDate;
  at: string;
  warehouseId: number;
  cashReceived: number;
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
              u.name AS soldBy, r.eta_uuid AS etaUuid, r.eta_previous_uuid AS etaPreviousUuid, r.eta_status AS etaStatus
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
  return rows.map((r) => {
    const ls = lines.all(r.id) as Receipt["lines"];
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
      change: r.cashReceived - (net + vat),
      soldBy: r.soldBy,
      eta: { uuid: r.etaUuid, previousUuid: r.etaPreviousUuid, status: r.etaStatus },
      lines: ls,
    };
  });
}
