import type Database from "better-sqlite3";
import { assertIsoDate } from "./dates";
import { BusinessError } from "./errors";
import type { Quantity } from "./items";
import { type IsoDate, type Piastres, postJournalEntry } from "./ledger";

export type Warehouse = { id: number; name: string; active: boolean };
export type StockOnHand = { total: Quantity; byWarehouse: { warehouseId: number; quantity: Quantity }[] };

/** A line counted in the item's base unit or its pack unit, in thousandths of that unit. */
export type UnitLine = { itemId: number; unit: "base" | "pack"; quantity: Quantity };
export type TransferInput = { date: IsoDate; from: number; to: number; memo: string; lines: UnitLine[] };
export type Transfer = { id: number; date: IsoDate; from: number; to: number; memo: string; lines: { itemId: number; quantity: Quantity }[] };
export type OpeningStockLine = { itemId: number; quantity: Quantity; unitCost: Piastres };

const ONE_BASE_UNIT = 1000;

type WarehouseRow = { id: number; name: string; active: number };
const toWarehouse = (r: WarehouseRow): Warehouse => ({ id: r.id, name: r.name, active: r.active === 1 });

export function listWarehouses(db: Database.Database): Warehouse[] {
  return (db.prepare("SELECT id, name, active FROM warehouses ORDER BY id").all() as WarehouseRow[]).map(toWarehouse);
}

function findWarehouse(db: Database.Database, id: number): Warehouse {
  const row = db.prepare("SELECT id, name, active FROM warehouses WHERE id = ?").get(id) as WarehouseRow | undefined;
  if (!row) throw new BusinessError("warehouse_not_found", `No warehouse with id ${id}`);
  return toWarehouse(row);
}

export function activeWarehouse(db: Database.Database, id: number): Warehouse {
  const warehouse = findWarehouse(db, id);
  if (!warehouse.active) throw new BusinessError("warehouse_inactive", `Warehouse ${warehouse.name} is stopped`);
  return warehouse;
}

function cleanWarehouseName(db: Database.Database, name: string, exceptId: number | null): string {
  const trimmed = name.trim();
  if (trimmed === "") throw new BusinessError("warehouse_name_required", "A warehouse needs a name");
  const owner = db.prepare("SELECT id FROM warehouses WHERE name = ?").get(trimmed) as { id: number } | undefined;
  if (owner && owner.id !== exceptId) throw new BusinessError("warehouse_name_taken", `A warehouse called ${trimmed} exists`);
  return trimmed;
}

export function addWarehouse(db: Database.Database, name: string): number {
  const clean = cleanWarehouseName(db, name, null);
  return Number(db.prepare("INSERT INTO warehouses (name) VALUES (?)").run(clean).lastInsertRowid);
}

export function renameWarehouse(db: Database.Database, id: number, name: string): void {
  findWarehouse(db, id);
  db.prepare("UPDATE warehouses SET name = ? WHERE id = ?").run(cleanWarehouseName(db, name, id), id);
}

export function setWarehouseActive(db: Database.Database, id: number, active: boolean): void {
  const warehouse = findWarehouse(db, id);
  if (!active) {
    const held = db
      .prepare("SELECT 1 FROM stock_movements WHERE warehouse_id = ? GROUP BY item_id HAVING SUM(quantity) <> 0 LIMIT 1")
      .get(id);
    if (held) throw new BusinessError("warehouse_has_stock", `Warehouse ${warehouse.name} still holds stock`);
  }
  db.prepare("UPDATE warehouses SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
}

function quantityIn(db: Database.Database, itemId: number, warehouseId: number): Quantity {
  const row = db
    .prepare("SELECT COALESCE(SUM(quantity), 0) AS q FROM stock_movements WHERE item_id = ? AND warehouse_id = ?")
    .get(itemId, warehouseId) as { q: number };
  return row.q;
}

export function stockOnHand(db: Database.Database, itemId: number): StockOnHand {
  const rows = db
    .prepare(
      `SELECT warehouse_id AS warehouseId, SUM(quantity) AS quantity FROM stock_movements
        WHERE item_id = ? GROUP BY warehouse_id HAVING SUM(quantity) <> 0 ORDER BY warehouse_id`,
    )
    .all(itemId) as { warehouseId: number; quantity: number }[];
  return { total: rows.reduce((t, r) => t + r.quantity, 0), byWarehouse: rows };
}

/**
 * Weighted average cost of one base unit, in piastres: the value of all stock
 * held divided by the quantity held, across every warehouse. Zero when none is held.
 */
export function averageCost(db: Database.Database, itemId: number): Piastres {
  const row = db
    .prepare("SELECT COALESCE(SUM(quantity), 0) AS q, COALESCE(SUM(value), 0) AS v FROM stock_movements WHERE item_id = ?")
    .get(itemId) as { q: number; v: number };
  return row.q <= 0 ? 0 : Math.round((row.v * ONE_BASE_UNIT) / row.q);
}

/** Value of all stock held of an item, in piastres: what the Stock account holds for it. */
export function stockValue(db: Database.Database, itemId: number): Piastres {
  return (db.prepare("SELECT COALESCE(SUM(value), 0) AS v FROM stock_movements WHERE item_id = ?").get(itemId) as { v: number }).v;
}

/**
 * The cost of taking a base quantity out of stock at the weighted average. Taking
 * everything held takes exactly its value, so no rounding is left behind. With
 * nothing held, the unit cost of the last receipt is used. `alreadyTaken` is stock taken
 * earlier in the same document but not yet recorded.
 */
export function costOfIssue(
  db: Database.Database,
  itemId: number,
  quantity: Quantity,
  alreadyTaken: { quantity: Quantity; value: Piastres } = { quantity: 0, value: 0 },
): Piastres {
  const row = db
    .prepare("SELECT COALESCE(SUM(quantity), 0) AS q, COALESCE(SUM(value), 0) AS v FROM stock_movements WHERE item_id = ?")
    .get(itemId) as { q: number; v: number };
  const held = { q: row.q - alreadyTaken.quantity, v: row.v - alreadyTaken.value };
  if (held.q > 0) return quantity === held.q ? held.v : Math.round((quantity * held.v) / held.q);
  const last = db
    .prepare("SELECT quantity, value FROM stock_movements WHERE item_id = ? AND quantity > 0 AND value > 0 ORDER BY id DESC LIMIT 1")
    .get(itemId) as { quantity: number; value: number } | undefined;
  return last ? Math.round((quantity * last.value) / last.quantity) : 0;
}

export function assertQuantity(quantity: number): void {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new BusinessError("quantity_invalid", `Quantity ${quantity} is not a positive whole number of thousandths`);
  }
}

/** Converts a line in base or pack units to thousandths of the base unit. */
export function toBaseQuantity(db: Database.Database, line: UnitLine): Quantity {
  assertQuantity(line.quantity);
  const unit = db
    .prepare(
      `SELECT u.size FROM items i LEFT JOIN item_units u ON u.item_id = i.id AND u.kind = ? WHERE i.id = ?`,
    )
    .get(line.unit, line.itemId) as { size: number | null } | undefined;
  if (!unit) throw new BusinessError("item_not_found", `No item with id ${line.itemId}`);
  if (unit.size === null) throw new BusinessError("item_has_no_pack", `Item ${line.itemId} has no pack unit`);
  const base = (line.quantity * unit.size) / ONE_BASE_UNIT;
  if (!Number.isSafeInteger(base)) throw new BusinessError("quantity_invalid", "Quantity does not convert to whole thousandths");
  return base;
}

export function insertMovement(
  db: Database.Database,
  m: { date: IsoDate; itemId: number; warehouseId: number; quantity: Quantity; value: Piastres; source: string; sourceId: number },
): void {
  db.prepare(
    "INSERT INTO stock_movements (date, item_id, warehouse_id, quantity, value, source, source_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(m.date, m.itemId, m.warehouseId, m.quantity, m.value, m.source, m.sourceId);
}

export function accountByRole(db: Database.Database, role: string): number {
  return (db.prepare("SELECT id FROM accounts WHERE role = ?").get(role) as { id: number }).id;
}

/** Stock a business holds when it starts: Dr Stock, Cr Opening balances, at the given unit cost. */
export function postOpeningStock(db: Database.Database, date: IsoDate, warehouseId: number, lines: OpeningStockLine[]): number {
  assertIsoDate(date);
  activeWarehouse(db, warehouseId);
  if (lines.length === 0) throw new BusinessError("transfer_needs_lines", "Opening stock needs at least one line");
  let total = 0;
  for (const line of lines) {
    assertQuantity(line.quantity);
    if (!Number.isSafeInteger(line.unitCost) || line.unitCost < 0) {
      throw new BusinessError("price_invalid", `Unit cost ${line.unitCost} is not whole piastres`);
    }
    if (!db.prepare("SELECT 1 FROM items WHERE id = ?").get(line.itemId)) {
      throw new BusinessError("item_not_found", `No item with id ${line.itemId}`);
    }
    total += Math.round((line.quantity * line.unitCost) / ONE_BASE_UNIT);
  }
  const entryId = postJournalEntry(
    db,
    {
      date,
      memo: "مخزون أول المدة",
      lines: [
        { accountId: accountByRole(db, "stock"), debit: total },
        { accountId: accountByRole(db, "opening_balances"), credit: total },
      ],
    },
    "opening_stock",
  );
  for (const line of lines) {
    insertMovement(db, {
      date,
      itemId: line.itemId,
      warehouseId,
      quantity: line.quantity,
      value: Math.round((line.quantity * line.unitCost) / ONE_BASE_UNIT),
      source: "opening_stock",
      sourceId: entryId,
    });
  }
  return entryId;
}

/** Moves stock between two warehouses. Cost is one average per item, so the books do not change. */
export function transferStock(db: Database.Database, input: TransferInput): number {
  assertIsoDate(input.date);
  if (input.from === input.to) throw new BusinessError("transfer_same_warehouse", "Pick two different warehouses");
  activeWarehouse(db, input.from);
  activeWarehouse(db, input.to);
  if (input.lines.length === 0) throw new BusinessError("transfer_needs_lines", "A transfer needs at least one line");
  const moves = new Map<number, Quantity>();
  for (const line of input.lines) {
    moves.set(line.itemId, (moves.get(line.itemId) ?? 0) + toBaseQuantity(db, line));
  }
  for (const [itemId, quantity] of moves) {
    if (quantityIn(db, itemId, input.from) < quantity) {
      throw new BusinessError("stock_insufficient", `Not enough of item ${itemId} in the source warehouse`);
    }
  }
  const id = Number(
    db
      .prepare("INSERT INTO stock_transfers (date, from_warehouse_id, to_warehouse_id, memo) VALUES (?, ?, ?, ?)")
      .run(input.date, input.from, input.to, input.memo.trim()).lastInsertRowid,
  );
  for (const [itemId, quantity] of moves) {
    const base = { date: input.date, itemId, value: 0, source: "transfer", sourceId: id };
    insertMovement(db, { ...base, warehouseId: input.from, quantity: -quantity });
    insertMovement(db, { ...base, warehouseId: input.to, quantity });
  }
  return id;
}

export function listTransfers(db: Database.Database): Transfer[] {
  const transfers = db
    .prepare(
      `SELECT id, date, from_warehouse_id AS "from", to_warehouse_id AS "to", memo
         FROM stock_transfers ORDER BY date DESC, id DESC`,
    )
    .all() as Omit<Transfer, "lines">[];
  const lines = db.prepare(
    `SELECT item_id AS itemId, quantity FROM stock_movements
      WHERE source = 'transfer' AND source_id = ? AND quantity > 0 ORDER BY id`,
  );
  return transfers.map((t) => ({ ...t, lines: lines.all(t.id) as Transfer["lines"] }));
}
