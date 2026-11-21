import type Database from "better-sqlite3";
import { assertIsoDate } from "./dates";
import { BusinessError } from "./errors";
import type { Quantity } from "./items";
import { type IsoDate, type JournalLine, type Piastres, postJournalEntry } from "./ledger";
import { issueSerials, serialsFor } from "./serials";
import { type SerialLine, type UnitLine, accountByRole, activeWarehouse, costOfIssue, insertMovement, toBaseQuantity } from "./stock";

export type StockCountInput = {
  date: IsoDate;
  warehouseId: number;
  memo: string;
  /** What was found on the shelves, in thousandths of the base unit. */
  lines: { itemId: number; counted: Quantity }[];
};
export type StockCount = {
  id: number;
  date: IsoDate;
  warehouseId: number;
  memo: string;
  /** `value` is the gain (positive) or loss (negative) posted for the difference. */
  lines: { itemId: number; nameAr: string; expected: Quantity; counted: Quantity; difference: Quantity; value: Piastres }[];
};
export type WriteOffInput = { date: IsoDate; warehouseId: number; reason: string; lines: (UnitLine & SerialLine)[] };
export type WriteOff = {
  id: number;
  date: IsoDate;
  warehouseId: number;
  reason: string;
  value: Piastres;
  lines: { itemId: number; nameAr: string; quantity: Quantity; value: Piastres }[];
};
export type LowStockRow = {
  itemId: number;
  nameAr: string;
  minQuantity: Quantity;
  onHand: Quantity;
  byWarehouse: { warehouseId: number; quantity: Quantity }[];
};
export type ItemMovement = {
  id: number;
  date: IsoDate;
  /** The kind of document: purchase, sale, sales_invoice, transfer, write_off, stock_count, … */
  source: string;
  sourceId: number;
  warehouseId: number;
  warehouseName: string;
  quantity: Quantity;
  value: Piastres;
  /** Quantity held after this movement, in the warehouses shown. */
  balance: Quantity;
};

function heldIn(db: Database.Database, itemId: number, warehouseId: number): Quantity {
  return (
    db.prepare("SELECT COALESCE(SUM(quantity), 0) AS q FROM stock_movements WHERE item_id = ? AND warehouse_id = ?").get(itemId, warehouseId) as {
      q: number;
    }
  ).q;
}

/** Posts a count: each item's difference from the books goes in as a gain (Dr Stock, Cr Stock gain) or out as a loss (Dr Stock loss, Cr Stock), at average cost. */
export function postStockCount(db: Database.Database, input: StockCountInput, userId: number): number {
  assertIsoDate(input.date);
  activeWarehouse(db, input.warehouseId);
  if (input.lines.length === 0) throw new BusinessError("count_needs_lines", "A count needs at least one item");
  const seen = new Set<number>();
  const lines = input.lines.map((l) => {
    if (!Number.isSafeInteger(l.counted) || l.counted < 0)
      throw new BusinessError("quantity_invalid", `Counted ${l.counted} is not whole thousandths`);
    if (seen.has(l.itemId)) throw new BusinessError("quantity_invalid", `Item ${l.itemId} is counted twice`);
    seen.add(l.itemId);
    const item = db.prepare("SELECT serialised FROM items WHERE id = ?").get(l.itemId) as { serialised: number } | undefined;
    if (!item) throw new BusinessError("item_not_found", `No item with id ${l.itemId}`);
    const expected = heldIn(db, l.itemId, input.warehouseId);
    const difference = l.counted - expected;
    // A serialised item's units are written off or received by serial number, not by a count.
    if (difference !== 0 && item.serialised === 1) throw new BusinessError("serials_required", `Item ${l.itemId} is serialised`);
    const value = difference === 0 ? 0 : difference < 0 ? -costOfIssue(db, l.itemId, -difference) : gainValue(db, l.itemId, difference);
    return { ...l, expected, difference, value };
  });

  const id = Number(
    db
      .prepare("INSERT INTO stock_counts (date, warehouse_id, memo, user_id) VALUES (?, ?, ?, ?)")
      .run(input.date, input.warehouseId, input.memo.trim(), userId).lastInsertRowid,
  );
  const insertLine = db.prepare("INSERT INTO stock_count_lines (count_id, item_id, expected, counted, value) VALUES (?, ?, ?, ?, ?)");
  for (const l of lines) {
    insertLine.run(id, l.itemId, l.expected, l.counted, l.value);
    if (l.difference !== 0)
      insertMovement(db, {
        date: input.date,
        itemId: l.itemId,
        warehouseId: input.warehouseId,
        quantity: l.difference,
        value: l.value,
        source: "stock_count",
        sourceId: id,
      });
  }
  const gain = lines.filter((l) => l.value > 0).reduce((t, l) => t + l.value, 0);
  const loss = -lines.filter((l) => l.value < 0).reduce((t, l) => t + l.value, 0);
  const journal: JournalLine[] = [];
  if (gain > 0) journal.push({ accountId: accountByRole(db, "stock"), debit: gain }, { accountId: accountByRole(db, "stock_gain"), credit: gain });
  if (loss > 0) journal.push({ accountId: accountByRole(db, "stock_loss"), debit: loss }, { accountId: accountByRole(db, "stock"), credit: loss });
  if (journal.length > 0) {
    const entryId = postJournalEntry(
      db,
      { date: input.date, memo: `جرد مخزن رقم ${id}${input.memo.trim() ? ` - ${input.memo.trim()}` : ""}`, lines: journal },
      "stock_count",
    );
    db.prepare("UPDATE stock_counts SET entry_id = ? WHERE id = ?").run(entryId, id);
  }
  return id;
}

/** Value of units found over the books: the average cost, or the last receipt's when none are held. */
function gainValue(db: Database.Database, itemId: number, quantity: Quantity): Piastres {
  const row = db
    .prepare("SELECT COALESCE(SUM(quantity), 0) AS q, COALESCE(SUM(value), 0) AS v FROM stock_movements WHERE item_id = ?")
    .get(itemId) as { q: number; v: number };
  if (row.q > 0) return Math.round((quantity * row.v) / row.q);
  return costOfIssue(db, itemId, quantity);
}

export function listStockCounts(db: Database.Database): StockCount[] {
  const lines = db.prepare(
    `SELECT l.item_id AS itemId, i.name_ar AS nameAr, l.expected, l.counted, l.counted - l.expected AS difference, l.value
       FROM stock_count_lines l JOIN items i ON i.id = l.item_id WHERE l.count_id = ? ORDER BY l.id`,
  );
  return (
    db.prepare("SELECT id, date, warehouse_id AS warehouseId, memo FROM stock_counts ORDER BY id DESC").all() as Omit<StockCount, "lines">[]
  ).map((c) => ({
    ...c,
    lines: lines.all(c.id) as StockCount["lines"],
  }));
}

/** Damaged, expired or lost stock taken out of one warehouse at average cost: Dr Stock loss, Cr Stock. */
export function writeOffStock(db: Database.Database, input: WriteOffInput, userId: number): number {
  assertIsoDate(input.date);
  activeWarehouse(db, input.warehouseId);
  const reason = input.reason.trim();
  if (reason === "") throw new BusinessError("reason_required", "A write-off needs a reason");
  if (input.lines.length === 0) throw new BusinessError("count_needs_lines", "A write-off needs at least one item");
  const taken = new Map<number, { quantity: Quantity; value: Piastres }>();
  const lines = input.lines.map((line) => {
    const base = toBaseQuantity(db, line);
    const before = taken.get(line.itemId) ?? { quantity: 0, value: 0 };
    if (heldIn(db, line.itemId, input.warehouseId) - before.quantity < base) {
      throw new BusinessError("stock_insufficient", `Not enough of item ${line.itemId} in the warehouse`);
    }
    const serials = serialsFor(db, line.itemId, base, line.serials);
    const value = costOfIssue(db, line.itemId, base, before);
    taken.set(line.itemId, { quantity: before.quantity + base, value: before.value + value });
    return { itemId: line.itemId, base, value, serials };
  });
  const total = lines.reduce((t, l) => t + l.value, 0);
  const id = Number(
    db.prepare("INSERT INTO write_offs (date, warehouse_id, reason, user_id) VALUES (?, ?, ?, ?)").run(input.date, input.warehouseId, reason, userId)
      .lastInsertRowid,
  );
  const insertLine = db.prepare("INSERT INTO write_off_lines (write_off_id, item_id, quantity, value) VALUES (?, ?, ?, ?)");
  lines.forEach((l) => {
    const lineId = Number(insertLine.run(id, l.itemId, l.base, l.value).lastInsertRowid);
    issueSerials(db, l.itemId, l.serials, { date: input.date, warehouseId: input.warehouseId, source: "write_off", sourceId: id, lineId });
    insertMovement(db, {
      date: input.date,
      itemId: l.itemId,
      warehouseId: input.warehouseId,
      quantity: -l.base,
      value: -l.value,
      source: "write_off",
      sourceId: id,
    });
  });
  if (total > 0) {
    const entryId = postJournalEntry(
      db,
      {
        date: input.date,
        memo: `إعدام مخزون رقم ${id} - ${reason}`,
        lines: [
          { accountId: accountByRole(db, "stock_loss"), debit: total },
          { accountId: accountByRole(db, "stock"), credit: total },
        ],
      },
      "write_off",
    );
    db.prepare("UPDATE write_offs SET entry_id = ? WHERE id = ?").run(entryId, id);
  }
  return id;
}

export function listWriteOffs(db: Database.Database): WriteOff[] {
  const lines = db.prepare(
    "SELECT l.item_id AS itemId, i.name_ar AS nameAr, l.quantity, l.value FROM write_off_lines l JOIN items i ON i.id = l.item_id WHERE l.write_off_id = ? ORDER BY l.id",
  );
  return (
    db.prepare("SELECT id, date, warehouse_id AS warehouseId, reason FROM write_offs ORDER BY id DESC").all() as Omit<WriteOff, "lines" | "value">[]
  ).map((w) => {
    const ls = lines.all(w.id) as WriteOff["lines"];
    return { ...w, value: ls.reduce((t, l) => t + l.value, 0), lines: ls };
  });
}

export function setItemMinimum(db: Database.Database, itemId: number, minimum: Quantity | null): void {
  if (minimum !== null && (!Number.isSafeInteger(minimum) || minimum < 0))
    throw new BusinessError("quantity_invalid", `Minimum ${minimum} is not whole thousandths`);
  if (db.prepare("UPDATE items SET min_quantity = ? WHERE id = ?").run(minimum, itemId).changes === 0)
    throw new BusinessError("item_not_found", `No item with id ${itemId}`);
}

/** Active items with a minimum whose stock is below it: in total, or in one warehouse. */
export function lowStock(db: Database.Database, warehouseId?: number): LowStockRow[] {
  const items = db
    .prepare(
      "SELECT id AS itemId, name_ar AS nameAr, min_quantity AS minQuantity FROM items WHERE active = 1 AND min_quantity IS NOT NULL ORDER BY name_ar",
    )
    .all() as Omit<LowStockRow, "onHand" | "byWarehouse">[];
  const by = db.prepare(
    "SELECT warehouse_id AS warehouseId, SUM(quantity) AS quantity FROM stock_movements WHERE item_id = ? GROUP BY warehouse_id HAVING SUM(quantity) <> 0 ORDER BY warehouse_id",
  );
  const rows: LowStockRow[] = [];
  for (const item of items) {
    const byWarehouse = by.all(item.itemId) as LowStockRow["byWarehouse"];
    const onHand =
      warehouseId === undefined
        ? byWarehouse.reduce((t, w) => t + w.quantity, 0)
        : (byWarehouse.find((w) => w.warehouseId === warehouseId)?.quantity ?? 0);
    if (onHand < item.minQuantity) rows.push({ ...item, onHand, byWarehouse });
  }
  return rows;
}

/** An item's movements in date order, with the quantity held after each, in all warehouses or one. */
export function itemMovements(db: Database.Database, itemId: number, warehouseId?: number): ItemMovement[] {
  const rows = db
    .prepare(
      `SELECT m.id, m.date, m.source, m.source_id AS sourceId, m.warehouse_id AS warehouseId, w.name AS warehouseName, m.quantity, m.value
         FROM stock_movements m JOIN warehouses w ON w.id = m.warehouse_id
        WHERE m.item_id = ? AND (? IS NULL OR m.warehouse_id = ?)
        ORDER BY m.date, m.id`,
    )
    .all(itemId, warehouseId ?? null, warehouseId ?? null) as Omit<ItemMovement, "balance">[];
  let balance = 0;
  return rows.map((r) => {
    balance += r.quantity;
    return { ...r, balance };
  });
}

/** The last stock movement's id, so a command's own movements can be told apart afterwards. */
export function lastMovementId(db: Database.Database): number {
  return (db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM stock_movements").get() as { id: number }).id;
}

/** Issues whose cost is taken at the average on their date, and the account their cost goes to. */
const REPRICED: Record<string, { role: string; lines?: { table: string; key: string } }> = {
  sale: { role: "cost_of_goods_sold", lines: { table: "sales_receipt_lines", key: "receipt_id" } },
  sales_invoice: { role: "cost_of_goods_sold", lines: { table: "sales_invoice_lines", key: "invoice_id" } },
  write_off: { role: "stock_loss", lines: { table: "write_off_lines", key: "write_off_id" } },
  stock_count: { role: "stock_loss" },
};

type Movement = { id: number; date: string; quantity: number; value: number; source: string; sourceId: number };

/**
 * After a command, finds items it moved on a date earlier than movements already there (a
 * back-dated purchase or sale) and reprices every later issue at the average as it stood on its
 * own date. Each changed cost is posted as an adjustment on that issue's date (Cost of goods sold
 * or Stock loss against Stock), and the documents' line costs follow, so the Stock account keeps
 * matching the stock value.
 */
export function repriceBackdated(db: Database.Database, since: number): void {
  const touched = db.prepare("SELECT item_id AS itemId, MIN(date) AS date FROM stock_movements WHERE id > ? GROUP BY item_id").all(since) as {
    itemId: number;
    date: string;
  }[];
  const later = db.prepare("SELECT 1 FROM stock_movements WHERE item_id = ? AND id <= ? AND date > ? LIMIT 1");
  for (const t of touched) {
    if (later.get(t.itemId, since, t.date)) repriceFrom(db, t.itemId, t.date);
  }
}

function repriceFrom(db: Database.Database, itemId: number, from: IsoDate): void {
  const moves = db
    .prepare("SELECT id, date, quantity, value, source, source_id AS sourceId FROM stock_movements WHERE item_id = ? ORDER BY date, id")
    .all(itemId) as Movement[];
  let q = 0;
  let v = 0;
  let lastReceipt: { quantity: number; value: number } | null = null;
  const changed: (Movement & { next: number })[] = [];
  for (const m of moves) {
    if (m.quantity < 0 && m.date >= from && REPRICED[m.source]) {
      const out = -m.quantity;
      const cost =
        q > 0 ? (out === q ? v : Math.round((out * v) / q)) : lastReceipt ? Math.round((out * lastReceipt.value) / lastReceipt.quantity) : 0;
      if (-cost !== m.value) changed.push({ ...m, next: -cost });
      m.value = -cost;
    }
    q += m.quantity;
    v += m.value;
    if (m.quantity > 0 && m.value > 0) lastReceipt = { quantity: m.quantity, value: m.value };
  }
  if (changed.length === 0) return;

  const update = db.prepare("UPDATE stock_movements SET value = ? WHERE id = ?");
  for (const c of changed) update.run(c.next, c.id);

  // One adjustment per date: what each account's cost moved by, against Stock.
  const name = (db.prepare("SELECT name_ar AS n FROM items WHERE id = ?").get(itemId) as { n: string }).n;
  const byDate = new Map<string, Map<string, number>>();
  for (const c of changed) {
    const role = REPRICED[c.source]!.role;
    const day = byDate.get(c.date) ?? new Map<string, number>();
    day.set(role, (day.get(role) ?? 0) + (c.value - c.next));
    byDate.set(c.date, day);
  }
  for (const [date, roles] of [...byDate].sort(([a], [b]) => a.localeCompare(b))) {
    const lines: JournalLine[] = [];
    let stock = 0;
    for (const [role, extra] of roles) {
      if (extra === 0) continue;
      lines.push(extra > 0 ? { accountId: accountByRole(db, role), debit: extra } : { accountId: accountByRole(db, role), credit: -extra });
      stock -= extra;
    }
    if (stock === 0) continue;
    lines.push(stock > 0 ? { accountId: accountByRole(db, "stock"), debit: stock } : { accountId: accountByRole(db, "stock"), credit: -stock });
    postJournalEntry(db, { date, memo: `تسوية تكلفة بأثر رجعي - ${name}`, lines }, "cost_adjustment");
  }

  // The documents' own line costs follow their movements, shared over their lines of this item by quantity.
  const docs = new Set(changed.map((c) => `${c.source}:${c.sourceId}`));
  for (const key of docs) {
    const [source, id] = key.split(":") as [string, string];
    const target = REPRICED[source]!.lines;
    if (source === "stock_count") {
      const total = (
        db
          .prepare("SELECT SUM(value) AS v FROM stock_movements WHERE item_id = ? AND source = ? AND source_id = ?")
          .get(itemId, source, Number(id)) as { v: number }
      ).v;
      db.prepare("UPDATE stock_count_lines SET value = ? WHERE count_id = ? AND item_id = ?").run(total, Number(id), itemId);
      continue;
    }
    if (!target) continue;
    const cost = -(
      db
        .prepare("SELECT SUM(value) AS v FROM stock_movements WHERE item_id = ? AND source = ? AND source_id = ?")
        .get(itemId, source, Number(id)) as { v: number }
    ).v;
    const column = source === "write_off" ? "value" : "cost";
    const docLines = db
      .prepare(`SELECT id, quantity FROM ${target.table} WHERE ${target.key} = ? AND item_id = ? ORDER BY id`)
      .all(Number(id), itemId) as { id: number; quantity: number }[];
    const all = docLines.reduce((t, l) => t + l.quantity, 0);
    let left = cost;
    docLines.forEach((l, i) => {
      const part = i === docLines.length - 1 ? left : Math.round((cost * l.quantity) / all);
      left -= part;
      db.prepare(`UPDATE ${target.table} SET ${column} = ? WHERE id = ?`).run(part, l.id);
    });
  }
}
