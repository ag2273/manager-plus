import type Database from "better-sqlite3";
import { BusinessError } from "./errors";
import type { Quantity } from "./items";
import type { IsoDate } from "./ledger";

/** Where one unit of a serialised item has been and where it is now. */
export type SerialHistory = {
  itemId: number;
  nameAr: string;
  serial: string;
  inStock: boolean;
  /** The warehouse it is in, or null when it is out of stock. */
  warehouseId: number | null;
  purchase: { date: IsoDate; supplierId: number; supplierName: string; reference: string } | null;
  sale: { date: IsoDate; document: string; customerId: number | null; customerName: string | null } | null;
  /** Sale date + warranty months; null when not sold or the item has no warranty. */
  warrantyEnds: IsoDate | null;
  underWarranty: boolean;
};
type Move = { date: IsoDate; warehouseId: number; source: string; sourceId: number; lineId: number | null };

const ONE_UNIT = 1000;

/** A date some months later, kept to the last day of a shorter month (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(date: IsoDate, months: number): IsoDate {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

function itemSerialSettings(db: Database.Database, itemId: number): { serialised: boolean; warrantyMonths: number } {
  const row = db.prepare("SELECT serialised, warranty_months AS warrantyMonths FROM items WHERE id = ?").get(itemId) as
    | { serialised: number; warrantyMonths: number }
    | undefined;
  return { serialised: row?.serialised === 1, warrantyMonths: row?.warrantyMonths ?? 0 };
}

/**
 * The serials a document line must carry: exactly one per unit for a serialised item
 * (so the quantity must be whole), none for any other item. Returns them trimmed.
 */
export function serialsFor(db: Database.Database, itemId: number, baseQuantity: Quantity, serials: string[] | undefined): string[] {
  const { serialised } = itemSerialSettings(db, itemId);
  const given = (serials ?? []).map((s) => s.trim()).filter((s) => s !== "");
  if (!serialised) {
    if (given.length > 0) throw new BusinessError("serials_not_expected", `Item ${itemId} does not take serial numbers`);
    return [];
  }
  if (baseQuantity % ONE_UNIT !== 0 || given.length !== baseQuantity / ONE_UNIT || new Set(given).size !== given.length) {
    throw new BusinessError("serials_required", `Item ${itemId} needs ${baseQuantity / ONE_UNIT} different serial numbers, one per unit`);
  }
  return given;
}

type State = { id: number; held: number; last: Move | null };

function stateOf(db: Database.Database, itemId: number, serial: string): State | null {
  const row = db.prepare("SELECT id FROM serials WHERE item_id = ? AND serial = ?").get(itemId, serial) as { id: number } | undefined;
  if (!row) return null;
  const held = (db.prepare("SELECT COALESCE(SUM(quantity), 0) AS q FROM serial_movements WHERE serial_id = ?").get(row.id) as { q: number }).q;
  const last = db
    .prepare(
      "SELECT date, warehouse_id AS warehouseId, source, source_id AS sourceId, line_id AS lineId FROM serial_movements WHERE serial_id = ? ORDER BY id DESC LIMIT 1",
    )
    .get(row.id) as Move | undefined;
  return { id: row.id, held, last: last ?? null };
}

function move(db: Database.Database, serialId: number, quantity: 1 | -1, m: Move): void {
  db.prepare(
    "INSERT INTO serial_movements (serial_id, date, warehouse_id, quantity, source, source_id, line_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(serialId, m.date, m.warehouseId, quantity, m.source, m.sourceId, m.lineId);
}

/** Units received from outside (a purchase, opening stock): none may already be in stock. */
export function receiveSerials(db: Database.Database, itemId: number, serials: string[], m: Move): void {
  for (const serial of serials) {
    const state = stateOf(db, itemId, serial);
    if (state && state.held > 0) throw new BusinessError("serial_in_stock", `Serial ${serial} is already in stock`);
    const id = state?.id ?? Number(db.prepare("INSERT INTO serials (item_id, serial) VALUES (?, ?)").run(itemId, serial).lastInsertRowid);
    move(db, id, 1, m);
  }
}

/** Units leaving a warehouse (a sale, a transfer out, back to the supplier): each must be in stock there. */
export function issueSerials(db: Database.Database, itemId: number, serials: string[], m: Move): void {
  for (const serial of serials) {
    const state = stateOf(db, itemId, serial);
    if (!state || state.held <= 0 || state.last?.warehouseId !== m.warehouseId) {
      throw new BusinessError("serial_not_in_stock", `Serial ${serial} is not in stock in warehouse ${m.warehouseId}`);
    }
    move(db, state.id, -1, m);
  }
}

/** Units coming back from a customer: each must have last left on the given sale document. */
export function returnSerials(db: Database.Database, itemId: number, serials: string[], soldOn: { source: string; sourceId: number }, m: Move): void {
  for (const serial of serials) {
    const state = stateOf(db, itemId, serial);
    if (!state || state.held > 0 || state.last?.source !== soldOn.source || state.last.sourceId !== soldOn.sourceId) {
      throw new BusinessError("serial_not_on_document", `Serial ${serial} was not sold on this document`);
    }
    move(db, state.id, 1, m);
  }
}

/** The serials that moved on one document line. */
export function serialsOnLine(db: Database.Database, source: string, sourceId: number, lineId: number): string[] {
  return (
    db
      .prepare(
        `SELECT s.serial FROM serial_movements m JOIN serials s ON s.id = m.serial_id
          WHERE m.source = ? AND m.source_id = ? AND m.line_id = ? ORDER BY m.id`,
      )
      .all(source, sourceId, lineId) as { serial: string }[]
  ).map((r) => r.serial);
}

/** Marks an item serialised (or not) with a warranty; only while it holds no stock that lacks serials. */
export function setItemSerials(db: Database.Database, itemId: number, input: { serialised: boolean; warrantyMonths: number }): void {
  if (!Number.isInteger(input.warrantyMonths) || input.warrantyMonths < 0 || input.warrantyMonths > 120) {
    throw new BusinessError("warranty_invalid", `Warranty of ${input.warrantyMonths} months is not 0–120`);
  }
  const current = db.prepare("SELECT serialised FROM items WHERE id = ?").get(itemId) as { serialised: number } | undefined;
  if (!current) throw new BusinessError("item_not_found", `No item with id ${itemId}`);
  if ((current.serialised === 1) !== input.serialised) {
    const held = (db.prepare("SELECT COALESCE(SUM(quantity), 0) AS q FROM stock_movements WHERE item_id = ?").get(itemId) as { q: number }).q;
    const serialsHeld = (
      db
        .prepare("SELECT COUNT(*) AS n FROM (SELECT m.serial_id FROM serial_movements m JOIN serials s ON s.id = m.serial_id WHERE s.item_id = ? GROUP BY m.serial_id HAVING SUM(m.quantity) > 0)")
        .get(itemId) as { n: number }
    ).n;
    const allSerialised = held === serialsHeld * ONE_UNIT;
    if (input.serialised ? !allSerialised : held !== 0) {
      throw new BusinessError("serial_setting_locked", `Item ${itemId} holds stock; serial tracking can change only with none on hand`);
    }
  }
  db.prepare("UPDATE items SET serialised = ?, warranty_months = ? WHERE id = ?").run(input.serialised ? 1 : 0, input.warrantyMonths, itemId);
}

const SALE_SOURCES = ["sale", "sales_invoice"];

/** Every unit with this serial (normally one item), with where it came from, where it went, and its warranty on `today`. */
export function findSerial(db: Database.Database, serial: string, today: IsoDate): SerialHistory[] {
  const rows = db
    .prepare("SELECT s.id, s.item_id AS itemId, i.name_ar AS nameAr, i.warranty_months AS months FROM serials s JOIN items i ON i.id = s.item_id WHERE s.serial = ?")
    .all(serial.trim()) as { id: number; itemId: number; nameAr: string; months: number }[];
  return rows.map((r) => {
    const state = stateOf(db, r.itemId, serial.trim())!;
    const purchase = db
      .prepare(
        `SELECT p.date, p.supplier_id AS supplierId, x.name AS supplierName, p.reference
           FROM serial_movements m JOIN purchase_invoices p ON p.id = m.source_id JOIN suppliers x ON x.id = p.supplier_id
          WHERE m.serial_id = ? AND m.source = 'purchase' ORDER BY m.id DESC LIMIT 1`,
      )
      .get(r.id) as SerialHistory["purchase"] | undefined;
    const lastOut = db
      .prepare(`SELECT source, source_id AS sourceId, date FROM serial_movements WHERE serial_id = ? AND quantity = -1 AND source IN ('sale', 'sales_invoice') ORDER BY id DESC LIMIT 1`)
      .get(r.id) as { source: string; sourceId: number; date: IsoDate } | undefined;
    // Sold, and not back in stock since: a returned unit is no longer the customer's.
    const sold = lastOut && !(state.held > 0) && SALE_SOURCES.includes(state.last?.source ?? "") ? lastOut : undefined;
    let sale: SerialHistory["sale"] = null;
    if (sold) {
      const doc =
        sold.source === "sale"
          ? (db.prepare("SELECT 'إيصال ' || r.number AS document, r.customer_id AS customerId, c.name AS customerName FROM sales_receipts r LEFT JOIN customers c ON c.id = r.customer_id WHERE r.id = ?").get(sold.sourceId) as Omit<NonNullable<SerialHistory["sale"]>, "date">)
          : (db.prepare("SELECT 'فاتورة ' || s.number AS document, s.customer_id AS customerId, c.name AS customerName FROM sales_invoices s JOIN customers c ON c.id = s.customer_id WHERE s.id = ?").get(sold.sourceId) as Omit<NonNullable<SerialHistory["sale"]>, "date">);
      sale = { date: sold.date, ...doc };
    }
    const warrantyEnds = sale && r.months > 0 ? addMonths(sale.date, r.months) : null;
    return {
      itemId: r.itemId,
      nameAr: r.nameAr,
      serial: serial.trim(),
      inStock: state.held > 0,
      warehouseId: state.held > 0 ? (state.last?.warehouseId ?? null) : null,
      purchase: purchase ?? null,
      sale,
      warrantyEnds,
      underWarranty: warrantyEnds !== null && today <= warrantyEnds,
    };
  });
}

/** The warranty end for a unit sold on `date`, or null for an item without warranty. */
export function warrantyEnd(db: Database.Database, itemId: number, date: IsoDate): IsoDate | null {
  const { warrantyMonths } = itemSerialSettings(db, itemId);
  return warrantyMonths > 0 ? addMonths(date, warrantyMonths) : null;
}
