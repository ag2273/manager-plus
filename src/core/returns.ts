import type Database from "better-sqlite3";
import { assertIsoDate } from "./dates";
import { BusinessError } from "./errors";
import type { Quantity } from "./items";
import { type IsoDate, type JournalLine, type Piastres, postJournalEntry } from "./ledger";
import { requireOpenShift } from "./shifts";
import { returnSerials, serialsFor } from "./serials";
import { accountByRole, assertQuantity, insertMovement } from "./stock";

export type ReturnInput = {
  date: IsoDate;
  receiptId: number;
  /** Receipt lines and how much of each comes back, in thousandths of the line's unit. */
  lines: { lineId: number; quantity: Quantity; serials?: string[] }[];
  /** Cash from the drawer, or credited to the receipt's customer. */
  refund: "cash" | "account";
};
export type ReturnResult = { id: number; number: number; total: Piastres };

type SoldLine = {
  id: number;
  itemId: number;
  unit: "base" | "pack";
  quantity: number;
  amount: number;
  net: number;
  vat: number;
  cost: number;
  size: number;
};
type Taken = { quantity: number; amount: number; net: number; cost: number };

const ONE_UNIT = 1000;

/** The share of a sold line's value for `quantity`; the last of the line takes exactly what is left. */
function share(line: SoldLine, before: Taken, quantity: Quantity) {
  const last = before.quantity + quantity === line.quantity;
  const part = (value: number, taken: number) => (last ? value - taken : Math.round((value * quantity) / line.quantity));
  const amount = part(line.amount, before.amount);
  const net = part(line.net, before.net);
  return { amount, net, vat: amount - net, cost: part(line.cost, before.cost) };
}

/**
 * Takes items back against the receipt they were sold on, at that sale's price, VAT
 * and cost: Dr Sales, Dr Output VAT, Cr Cash drawer or Receivables; Dr Stock, Cr Cost
 * of goods sold; stock back into the warehouse it was sold from.
 */
export function returnSale(db: Database.Database, input: ReturnInput, userId: number): ReturnResult {
  assertIsoDate(input.date);
  const shift = requireOpenShift(db, userId);
  const receipt = db.prepare("SELECT id, number, warehouse_id AS warehouseId, customer_id AS customerId FROM sales_receipts WHERE id = ?").get(
    input.receiptId,
  ) as { id: number; number: number; warehouseId: number; customerId: number | null } | undefined;
  if (!receipt) throw new BusinessError("receipt_not_found", `No receipt with id ${input.receiptId}`);
  if (input.lines.length === 0) throw new BusinessError("invoice_needs_lines", "A return needs at least one line");
  if (input.refund === "account" && receipt.customerId === null) {
    throw new BusinessError("customer_not_found", "This receipt has no customer to credit");
  }

  const soldLine = db.prepare(
    `SELECT l.id, l.item_id AS itemId, l.unit, l.quantity, l.gross - l.discount AS amount, l.net, l.vat, l.cost,
            COALESCE(u.size, 1000) AS size
       FROM sales_receipt_lines l LEFT JOIN item_units u ON u.item_id = l.item_id AND u.kind = l.unit
      WHERE l.id = ? AND l.receipt_id = ?`,
  );
  const returnedBefore = db.prepare(
    `SELECT COALESCE(SUM(quantity), 0) AS quantity, COALESCE(SUM(amount), 0) AS amount,
            COALESCE(SUM(net), 0) AS net, COALESCE(SUM(cost), 0) AS cost
       FROM sales_return_lines WHERE receipt_line_id = ?`,
  );
  const taken = new Map<number, Taken>();
  const backs = input.lines.map(({ lineId, quantity, serials: given }) => {
    assertQuantity(quantity);
    const line = soldLine.get(lineId, receipt.id) as SoldLine | undefined;
    if (!line) throw new BusinessError("return_line_invalid", `Line ${lineId} is not on receipt ${receipt.number}`);
    const before = taken.get(lineId) ?? (returnedBefore.get(lineId) as Taken);
    if (before.quantity + quantity > line.quantity) {
      throw new BusinessError("return_exceeds_sale", `Only ${line.quantity - before.quantity} of line ${lineId} can still be returned`);
    }
    const values = share(line, before, quantity);
    taken.set(lineId, {
      quantity: before.quantity + quantity,
      amount: before.amount + values.amount,
      net: before.net + values.net,
      cost: before.cost + values.cost,
    });
    const base = Math.round((quantity * line.size) / ONE_UNIT);
    return { line, quantity, base, ...values, serials: serialsFor(db, line.itemId, base, given) };
  });

  const total = backs.reduce((t, b) => t + b.amount, 0);
  const net = backs.reduce((t, b) => t + b.net, 0);
  const vat = backs.reduce((t, b) => t + b.vat, 0);
  const cost = backs.reduce((t, b) => t + b.cost, 0);
  const number = (db.prepare("SELECT COALESCE(MAX(number), 0) + 1 AS n FROM sales_returns").get() as { n: number }).n;

  const journal: JournalLine[] = [];
  if (net > 0) journal.push({ accountId: accountByRole(db, "sales"), debit: net });
  if (vat > 0) journal.push({ accountId: accountByRole(db, "output_vat"), debit: vat });
  if (total > 0) {
    journal.push(
      input.refund === "cash" || receipt.customerId === null
        ? { accountId: accountByRole(db, "cash_drawer"), credit: total }
        : { accountId: accountByRole(db, "receivables"), credit: total, customerId: receipt.customerId },
    );
  }
  if (cost > 0) {
    journal.push({ accountId: accountByRole(db, "stock"), debit: cost });
    journal.push({ accountId: accountByRole(db, "cost_of_goods_sold"), credit: cost });
  }
  const entryId = postJournalEntry(db, { date: input.date, memo: `مرتجع رقم ${number} من إيصال ${receipt.number}`, lines: journal }, "sale_return");
  const id = Number(
    db
      .prepare(
        `INSERT INTO sales_returns (number, date, at, receipt_id, shift_id, user_id, entry_id, refund)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(number, input.date, new Date().toISOString(), receipt.id, shift.id, userId, entryId, input.refund).lastInsertRowid,
  );
  const insertLine = db.prepare(
    "INSERT INTO sales_return_lines (return_id, receipt_line_id, quantity, amount, net, vat, cost) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const b of backs) {
    const lineId = Number(insertLine.run(id, b.line.id, b.quantity, b.amount, b.net, b.vat, b.cost).lastInsertRowid);
    returnSerials(db, b.line.itemId, b.serials, { source: "sale", sourceId: receipt.id }, { date: input.date, warehouseId: receipt.warehouseId, source: "sale_return", sourceId: id, lineId });
    insertMovement(db, {
      date: input.date,
      itemId: b.line.itemId,
      warehouseId: receipt.warehouseId,
      quantity: b.base,
      value: b.cost,
      source: "sale_return",
      sourceId: id,
    });
  }
  return { id, number, total };
}

export type SaleReturn = {
  id: number;
  number: number;
  date: IsoDate;
  at: string;
  receiptNumber: number;
  refund: "cash" | "account";
  returnedBy: string;
  total: Piastres;
  vat: Piastres;
  lines: { itemId: number; nameAr: string; unit: "base" | "pack"; quantity: Quantity; amount: Piastres; vat: Piastres }[];
};

/** One return by its printed number. */
export function findReturn(db: Database.Database, number: number): SaleReturn {
  const row = db
    .prepare(
      `SELECT x.id, x.number, x.date, x.at, r.number AS receiptNumber, x.refund, u.name AS returnedBy
         FROM sales_returns x JOIN sales_receipts r ON r.id = x.receipt_id JOIN users u ON u.id = x.user_id
        WHERE x.number = ?`,
    )
    .get(number) as Omit<SaleReturn, "lines" | "total" | "vat"> | undefined;
  if (!row) throw new BusinessError("receipt_not_found", `No return number ${number}`);
  const lines = db
    .prepare(
      `SELECT l.item_id AS itemId, i.name_ar AS nameAr, l.unit, x.quantity, x.amount, x.vat
         FROM sales_return_lines x
         JOIN sales_receipt_lines l ON l.id = x.receipt_line_id
         JOIN items i ON i.id = l.item_id
        WHERE x.return_id = ? ORDER BY x.id`,
    )
    .all(row.id) as SaleReturn["lines"];
  return { ...row, lines, total: lines.reduce((t, l) => t + l.amount, 0), vat: lines.reduce((t, l) => t + l.vat, 0) };
}
