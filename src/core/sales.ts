import type Database from "better-sqlite3";
import { assertIsoDate } from "./dates";
import { BusinessError } from "./errors";
import { type BasisPoints, type Quantity, vatRate } from "./items";
import { type IsoDate, type JournalLine, type Piastres, postJournalEntry } from "./ledger";
import { vatRegistered } from "./purchases";
import { requireOpenShift } from "./shifts";
import { findCustomer } from "./customers";
import { issueSerials, serialsFor, serialsOnLine, warrantyEnd } from "./serials";
import {
  type SerialLine,
  type UnitLine,
  accountByRole,
  activeWarehouse,
  assertQuantity,
  costOfIssue,
  insertMovement,
  toBaseQuantity,
} from "./stock";

/** A discount in piastres off, or a percentage in basis points (1000 = 10%). */
export type Discount = { kind: "amount" | "percent"; value: number };
/** A till line: the item, which unit was rung up, how many (thousandths of that unit), and any discount. */
export type SaleLineInput = UnitLine & SerialLine & { discount?: Discount };
export type SaleLine = UnitLine & {
  unitPrice: Piastres;
  /** Quantity × shelf price, before discounts. */
  gross: Piastres;
  /** The line's own discount plus its share of the receipt discount. */
  discount: Piastres;
  /** What the customer pays for the line: gross − discount, VAT included. */
  amount: Piastres;
  net: Piastres;
  vatRate: BasisPoints;
  vat: Piastres;
};
export type PricedSale = {
  lines: SaleLine[];
  /** Shelf prices before any discount. */
  gross: Piastres;
  discount: Piastres;
  net: Piastres;
  vat: Piastres;
  total: Piastres;
};
export type PaymentMethod = "cash" | "card" | "wallet";
export const PAYMENT_METHODS: readonly PaymentMethod[] = ["cash", "card", "wallet"];
/** A tender at the till. Cash is what the customer handed over, before change. */
export type Payment = { method: PaymentMethod; amount: Piastres };
export type SaleInput = {
  date: IsoDate;
  warehouseId: number;
  lines: SaleLineInput[];
  payments: Payment[];
  /** A discount on the whole receipt, spread over the lines. */
  discount?: Discount;
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
  lines: (SaleLine & { lineId: number; nameAr: string; cost: Piastres; returned: Quantity; serials: string[]; warrantyEnds: IsoDate | null })[];
};

const ONE_UNIT = 1000;
const WHOLE = 10_000;

/** The piastres a discount takes off `amount`; refuses a negative discount or one larger than the amount. */
function discountOff(discount: Discount | undefined, amount: Piastres): Piastres {
  if (!discount) return 0;
  const { kind, value } = discount;
  const valid = Number.isSafeInteger(value) && value >= 0 && (kind === "amount" ? value <= amount : kind === "percent" && value <= WHOLE);
  if (!valid) throw new BusinessError("discount_invalid", `Discount ${kind} ${value} does not fit an amount of ${amount}`);
  return kind === "amount" ? value : Math.round((amount * value) / WHOLE);
}

/** Splits `total` over `weights` in proportion, rounding down; the remainder goes to the largest weight. */
function spread(total: Piastres, weights: Piastres[]): Piastres[] {
  const sum = weights.reduce((t, w) => t + w, 0);
  if (total === 0 || sum === 0) return weights.map(() => 0);
  const shares = weights.map((w) => Math.floor((total * w) / sum));
  const largest = weights.indexOf(Math.max(...weights));
  shares[largest]! += total - shares.reduce((t, x) => t + x, 0);
  return shares;
}

/**
 * Prices till lines at the shelf price of the unit rung up, less line discounts and
 * a share of any receipt discount. Shelf prices include VAT, so per line:
 * net = round(amount / (1 + rate)), half-up, and VAT = amount − net.
 */
export function priceSale(db: Database.Database, date: IsoDate, lines: SaleLineInput[], receiptDiscount?: Discount): PricedSale {
  assertIsoDate(date);
  const registered = vatRegistered(db);
  const unitOf = db.prepare(
    `SELECT u.sale_price AS price, i.tax_code_id AS taxCodeId
       FROM items i JOIN item_units u ON u.item_id = i.id AND u.kind = ?
      WHERE i.id = ?`,
  );
  const shelf = lines.map((line) => {
    assertQuantity(line.quantity);
    const unit = unitOf.get(line.unit, line.itemId) as { price: number; taxCodeId: number } | undefined;
    if (!unit) {
      const exists = db.prepare("SELECT 1 FROM items WHERE id = ?").get(line.itemId);
      if (!exists) throw new BusinessError("item_not_found", `No item with id ${line.itemId}`);
      throw new BusinessError("item_has_no_pack", `Item ${line.itemId} has no pack unit`);
    }
    const gross = Math.round((line.quantity * unit.price) / ONE_UNIT);
    const own = discountOff(line.discount, gross);
    return { line, unit, gross, own, afterOwn: gross - own };
  });
  const subtotal = shelf.reduce((t, l) => t + l.afterOwn, 0);
  const shares = spread(
    discountOff(receiptDiscount, subtotal),
    shelf.map((l) => l.afterOwn),
  );
  const priced = shelf.map(({ line, unit, gross, own, afterOwn }, i): SaleLine => {
    const amount = afterOwn - shares[i]!;
    const rate = vatRate(db, unit.taxCodeId, date, registered);
    const net = Math.round((amount * WHOLE) / (WHOLE + rate));
    return {
      itemId: line.itemId,
      unit: line.unit,
      quantity: line.quantity,
      unitPrice: unit.price,
      gross,
      discount: own + shares[i]!,
      amount,
      net,
      vatRate: rate,
      vat: amount - net,
    };
  });
  const net = priced.reduce((t, l) => t + l.net, 0);
  const vat = priced.reduce((t, l) => t + l.vat, 0);
  const discount = priced.reduce((t, l) => t + l.discount, 0);
  const gross = priced.reduce((t, l) => t + l.gross, 0);
  return { lines: priced, gross, discount, net, vat, total: net + vat };
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
  const priced = priceSale(db, input.date, input.lines, input.discount);
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
  const outs = priced.lines.map((line, index) => {
    const base = toBaseQuantity(db, line);
    const serials = serialsFor(db, line.itemId, base, input.lines[index]!.serials);
    const before = taken.get(line.itemId) ?? { quantity: 0, value: 0 };
    const cost = costOfIssue(db, line.itemId, base, before);
    taken.set(line.itemId, { quantity: before.quantity + base, value: before.value + cost });
    return { line, base, cost, serials };
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
    `INSERT INTO sales_receipt_lines (receipt_id, item_id, unit, quantity, unit_price, gross, discount, net, vat_rate, vat, cost)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const { line: l, base, cost, serials } of outs) {
    const lineId = Number(insertLine.run(id, l.itemId, l.unit, l.quantity, l.unitPrice, l.gross, l.discount, l.net, l.vatRate, l.vat, cost).lastInsertRowid);
    issueSerials(db, l.itemId, serials, { date: input.date, warehouseId: input.warehouseId, source: "sale", sourceId: id, lineId });
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

const SELECT_RECEIPTS = `
  SELECT r.id, r.number, r.date, r.at, r.warehouse_id AS warehouseId, r.cash_received AS cashReceived,
         r.customer_id AS customerId, u.name AS soldBy, r.eta_uuid AS etaUuid,
         r.eta_previous_uuid AS etaPreviousUuid, r.eta_status AS etaStatus
    FROM sales_receipts r JOIN users u ON u.id = r.user_id`;

function toReceipts(db: Database.Database, rows: ReceiptRow[]): Receipt[] {
  const lines = db.prepare(
    `SELECT l.id AS lineId, l.item_id AS itemId, i.name_ar AS nameAr, l.unit, l.quantity, l.unit_price AS unitPrice,
            l.gross, l.discount, l.gross - l.discount AS amount, l.net, l.vat_rate AS vatRate, l.vat, l.cost,
            COALESCE((SELECT SUM(x.quantity) FROM sales_return_lines x WHERE x.receipt_line_id = l.id), 0) AS returned
       FROM sales_receipt_lines l JOIN items i ON i.id = l.item_id
      WHERE l.receipt_id = ? ORDER BY l.id`,
  );
  const payments = db.prepare("SELECT method, amount FROM sales_receipt_payments WHERE receipt_id = ? ORDER BY id");
  return rows.map((r) => {
    const ls = (lines.all(r.id) as Omit<Receipt["lines"][number], "serials" | "warrantyEnds">[]).map((l) => {
      const serials = serialsOnLine(db, "sale", r.id, l.lineId);
      return { ...l, serials, warrantyEnds: serials.length > 0 ? warrantyEnd(db, l.itemId, r.date) : null };
    });
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

/** Receipts, newest first. */
export function listReceipts(db: Database.Database, limit = 200): Receipt[] {
  return toReceipts(db, db.prepare(`${SELECT_RECEIPTS} ORDER BY r.number DESC LIMIT ?`).all(limit) as ReceiptRow[]);
}

/** One receipt by its printed number, with how much of each line was already returned. */
export function findReceipt(db: Database.Database, number: number): Receipt {
  const row = db.prepare(`${SELECT_RECEIPTS} WHERE r.number = ?`).get(number) as ReceiptRow | undefined;
  if (!row) throw new BusinessError("receipt_not_found", `No receipt number ${number}`);
  return toReceipts(db, [row])[0]!;
}

export type HeldSaleInput = { warehouseId: number; lines: SaleLineInput[]; discount?: Discount; note: string };
export type HeldSale = HeldSaleInput & { id: number; at: string; heldBy: string };

/** Puts a cart aside: nothing is posted and no receipt number is used. */
export function holdSale(db: Database.Database, userId: number, input: HeldSaleInput): number {
  if (input.lines.length === 0) throw new BusinessError("invoice_needs_lines", "A held sale needs at least one line");
  input.lines.forEach((l) => assertQuantity(l.quantity));
  const cart = { warehouseId: input.warehouseId, lines: input.lines, ...(input.discount ? { discount: input.discount } : {}) };
  return Number(
    db
      .prepare("INSERT INTO held_sales (user_id, at, note, cart) VALUES (?, ?, ?, ?)")
      .run(userId, new Date().toISOString(), input.note.trim(), JSON.stringify(cart)).lastInsertRowid,
  );
}

type HeldRow = { id: number; at: string; note: string; cart: string; heldBy: string };
const toHeld = (r: HeldRow): HeldSale => ({ id: r.id, at: r.at, note: r.note, heldBy: r.heldBy, ...(JSON.parse(r.cart) as Omit<HeldSaleInput, "note">) });
const SELECT_HELD = "SELECT h.id, h.at, h.note, h.cart, u.name AS heldBy FROM held_sales h JOIN users u ON u.id = h.user_id";

/** Held carts, oldest first. */
export function listHeldSales(db: Database.Database): HeldSale[] {
  return (db.prepare(`${SELECT_HELD} ORDER BY h.id`).all() as HeldRow[]).map(toHeld);
}

/** Takes a held cart back to the till; it is no longer held. */
export function recallSale(db: Database.Database, id: number): HeldSale {
  const row = db.prepare(`${SELECT_HELD} WHERE h.id = ?`).get(id) as HeldRow | undefined;
  if (!row) throw new BusinessError("held_sale_not_found", `No held sale with id ${id}`);
  db.prepare("DELETE FROM held_sales WHERE id = ?").run(id);
  return toHeld(row);
}
