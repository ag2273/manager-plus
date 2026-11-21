import type Database from "better-sqlite3";
import { assertIsoDate } from "./dates";
import { BusinessError } from "./errors";
import type { IsoDate, Piastres } from "./ledger";

/** Integer thousandths of an item's base unit: 1000 = one piece or one kilogram. */
export type Quantity = number;
/** Basis points: 1400 = 14%. */
export type BasisPoints = number;

export type TaxCodeKind = "standard" | "zero_rated" | "exempt";
export type TaxCode = { id: number; kind: TaxCodeKind; name: string; rates: { from: IsoDate; rate: BasisPoints }[] };

export type PackUnit = { name: string; size: Quantity; barcode: string | null; salePrice: Piastres; wholesalePrice: Piastres | null };
export type Item = {
  id: number;
  nameAr: string;
  nameEn: string;
  code: string | null;
  baseUnit: string;
  barcode: string | null;
  /** VAT-inclusive price of one base unit. */
  salePrice: Piastres;
  /** VAT-inclusive price for wholesale customers; the retail price when not set. */
  wholesalePrice: Piastres | null;
  taxCodeId: number;
  egsCode: string;
  pack: PackUnit | null;
  /** Every unit carries its own serial number on every document. */
  serialised: boolean;
  warrantyMonths: number;
  active: boolean;
};

export type PackUnitInput = { name: string; size: Quantity; barcode?: string; salePrice: Piastres; wholesalePrice?: Piastres | null };
export type ItemInput = {
  nameAr: string;
  nameEn?: string;
  code?: string;
  baseUnit: string;
  barcode?: string;
  salePrice: Piastres;
  wholesalePrice?: Piastres | null;
  taxCodeId: number;
  egsCode?: string;
  pack?: PackUnitInput | null;
};
export type ItemChanges = Partial<ItemInput>;

export type ScannedUnit = {
  itemId: number;
  nameAr: string;
  unit: "base" | "pack";
  unitName: string;
  /** How much of the base unit one of this unit is. */
  quantity: Quantity;
  salePrice: Piastres;
  taxCodeId: number;
  /** A serialised item is added at the till by scanning each unit's serial, not its barcode. */
  serialised: boolean;
};

const ONE_BASE_UNIT = 1000;

export function listTaxCodes(db: Database.Database): TaxCode[] {
  const codes = db.prepare("SELECT id, kind, name FROM tax_codes ORDER BY id").all() as Omit<TaxCode, "rates">[];
  const rates = db.prepare(
    "SELECT effective_from AS \"from\", rate FROM tax_rates WHERE tax_code_id = ? ORDER BY effective_from",
  );
  return codes.map((c) => ({ ...c, rates: rates.all(c.id) as TaxCode["rates"] }));
}

function assertTaxCode(db: Database.Database, id: number): void {
  if (!db.prepare("SELECT 1 FROM tax_codes WHERE id = ?").get(id)) {
    throw new BusinessError("tax_code_not_found", `No tax code with id ${id}`);
  }
}

export function addTaxRate(db: Database.Database, taxCodeId: number, input: { from: IsoDate; rate: BasisPoints }): void {
  assertTaxCode(db, taxCodeId);
  assertIsoDate(input.from);
  if (!Number.isInteger(input.rate) || input.rate < 0 || input.rate > 10_000) {
    throw new BusinessError("tax_rate_invalid", `Rate ${input.rate} is not between 0 and 10000 basis points`);
  }
  db.prepare(
    "INSERT INTO tax_rates (tax_code_id, effective_from, rate) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET rate = excluded.rate",
  ).run(taxCodeId, input.from, input.rate);
}

/** The VAT rate in force on `date`. Zero for everything when the business is not VAT-registered. */
export function vatRate(db: Database.Database, taxCodeId: number, date: IsoDate, vatRegistered: boolean): BasisPoints {
  assertTaxCode(db, taxCodeId);
  assertIsoDate(date);
  if (!vatRegistered) return 0;
  const row = db
    .prepare("SELECT rate FROM tax_rates WHERE tax_code_id = ? AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1")
    .get(taxCodeId, date) as { rate: number } | undefined;
  if (!row) throw new BusinessError("tax_rate_missing", `No rate in force on ${date} for tax code ${taxCodeId}`);
  return row.rate;
}

type ItemRow = {
  id: number;
  name_ar: string;
  name_en: string;
  code: string | null;
  tax_code_id: number;
  egs_code: string;
  active: number;
  serialised: number;
  warranty_months: number;
  base_name: string;
  base_barcode: string | null;
  base_price: number;
  base_wholesale: number | null;
  pack_wholesale: number | null;
  pack_name: string | null;
  pack_size: number | null;
  pack_barcode: string | null;
  pack_price: number | null;
};

const SELECT_ITEMS = `
  SELECT i.id, i.name_ar, i.name_en, i.code, i.tax_code_id, i.egs_code, i.active, i.serialised, i.warranty_months,
         b.name AS base_name, b.barcode AS base_barcode, b.sale_price AS base_price, b.wholesale_price AS base_wholesale, p.wholesale_price AS pack_wholesale,
         p.name AS pack_name, p.size AS pack_size, p.barcode AS pack_barcode, p.sale_price AS pack_price
    FROM items i
    JOIN item_units b ON b.item_id = i.id AND b.kind = 'base'
    LEFT JOIN item_units p ON p.item_id = i.id AND p.kind = 'pack'`;

function toItem(r: ItemRow): Item {
  return {
    id: r.id,
    nameAr: r.name_ar,
    nameEn: r.name_en,
    code: r.code,
    baseUnit: r.base_name,
    barcode: r.base_barcode,
    salePrice: r.base_price,
    wholesalePrice: r.base_wholesale,
    taxCodeId: r.tax_code_id,
    egsCode: r.egs_code,
    pack:
      r.pack_name === null
        ? null
        : { name: r.pack_name, size: r.pack_size ?? 0, barcode: r.pack_barcode, salePrice: r.pack_price ?? 0, wholesalePrice: r.pack_wholesale },
    serialised: r.serialised === 1,
    warrantyMonths: r.warranty_months,
    active: r.active === 1,
  };
}

/** Folds the Arabic letter variants people type interchangeably, and English case, so search finds either. */
function forSearch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ً-ْـ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي");
}

export function listItems(db: Database.Database, options: { search?: string; includeInactive?: boolean } = {}): Item[] {
  const rows = db
    .prepare(`${SELECT_ITEMS} ${options.includeInactive ? "" : "WHERE i.active = 1"} ORDER BY i.name_ar`)
    .all() as ItemRow[];
  const items = rows.map(toItem);
  const term = forSearch(options.search?.trim() ?? "");
  if (term === "") return items;
  return items.filter((i) =>
    [i.nameAr, i.nameEn, i.code, i.barcode, i.pack?.barcode].some((field) => field && forSearch(field).includes(term)),
  );
}

function blankToNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

function assertPrice(price: number): void {
  if (!Number.isSafeInteger(price) || price < 0) throw new BusinessError("price_invalid", `Price ${price} is not whole piastres`);
}

function required(value: string, what: string, code: "item_name_required" | "item_unit_required"): string {
  const trimmed = value.trim();
  if (trimmed === "") throw new BusinessError(code, `${what} is required`);
  return trimmed;
}

type CleanItem = {
  nameAr: string;
  nameEn: string;
  code: string | null;
  baseUnit: string;
  barcode: string | null;
  salePrice: Piastres;
  wholesalePrice: Piastres | null;
  taxCodeId: number;
  egsCode: string;
  pack: PackUnit | null;
};

function optionalPrice(price: Piastres | null | undefined): Piastres | null {
  if (price === null || price === undefined) return null;
  assertPrice(price);
  return price;
}

function cleanItem(db: Database.Database, input: ItemInput): CleanItem {
  const nameAr = required(input.nameAr, "Arabic name", "item_name_required");
  const baseUnit = required(input.baseUnit, "Base unit", "item_unit_required");
  assertPrice(input.salePrice);
  assertTaxCode(db, input.taxCodeId);
  let pack: PackUnit | null = null;
  if (input.pack) {
    const name = required(input.pack.name, "Pack unit name", "item_unit_required");
    if (!Number.isSafeInteger(input.pack.size) || input.pack.size <= 0) {
      throw new BusinessError("pack_size_invalid", `Pack size ${input.pack.size} is not a positive whole quantity`);
    }
    assertPrice(input.pack.salePrice);
    pack = {
      name,
      size: input.pack.size,
      barcode: blankToNull(input.pack.barcode),
      salePrice: input.pack.salePrice,
      wholesalePrice: optionalPrice(input.pack.wholesalePrice),
    };
  }
  const clean = {
    nameAr,
    nameEn: input.nameEn?.trim() ?? "",
    code: blankToNull(input.code),
    baseUnit,
    barcode: blankToNull(input.barcode),
    salePrice: input.salePrice,
    wholesalePrice: optionalPrice(input.wholesalePrice),
    taxCodeId: input.taxCodeId,
    egsCode: input.egsCode?.trim() ?? "",
    pack,
  };
  if (clean.barcode !== null && clean.barcode === pack?.barcode) {
    throw new BusinessError("barcode_taken", `Barcode ${clean.barcode} is used for both units`);
  }
  return clean;
}

function assertFree(db: Database.Database, item: CleanItem, itemId: number | null): void {
  if (item.code !== null) {
    const owner = db.prepare("SELECT id FROM items WHERE code = ?").get(item.code) as { id: number } | undefined;
    if (owner && owner.id !== itemId) throw new BusinessError("item_code_taken", `Item code ${item.code} is already used`);
  }
  for (const barcode of [item.barcode, item.pack?.barcode ?? null]) {
    if (barcode === null) continue;
    const owner = db.prepare("SELECT item_id FROM item_units WHERE barcode = ?").get(barcode) as { item_id: number } | undefined;
    if (owner && owner.item_id !== itemId) throw new BusinessError("barcode_taken", `Barcode ${barcode} is already used`);
  }
}

function writeUnits(db: Database.Database, itemId: number, item: CleanItem): void {
  db.prepare("DELETE FROM item_units WHERE item_id = ?").run(itemId);
  const insert = db.prepare(
    "INSERT INTO item_units (item_id, kind, name, size, barcode, sale_price, wholesale_price) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run(itemId, "base", item.baseUnit, ONE_BASE_UNIT, item.barcode, item.salePrice, item.wholesalePrice);
  if (item.pack) insert.run(itemId, "pack", item.pack.name, item.pack.size, item.pack.barcode, item.pack.salePrice, item.pack.wholesalePrice);
}

export function addItem(db: Database.Database, input: ItemInput): number {
  const item = cleanItem(db, input);
  assertFree(db, item, null);
  const id = Number(
    db
      .prepare("INSERT INTO items (name_ar, name_en, code, tax_code_id, egs_code) VALUES (?, ?, ?, ?, ?)")
      .run(item.nameAr, item.nameEn, item.code, item.taxCodeId, item.egsCode).lastInsertRowid,
  );
  writeUnits(db, id, item);
  return id;
}

function findItem(db: Database.Database, id: number): Item {
  const row = db.prepare(`${SELECT_ITEMS} WHERE i.id = ?`).get(id) as ItemRow | undefined;
  if (!row) throw new BusinessError("item_not_found", `No item with id ${id}`);
  return toItem(row);
}

export function updateItem(db: Database.Database, id: number, changes: ItemChanges): void {
  const current = findItem(db, id);
  const merged: ItemInput = {
    nameAr: current.nameAr,
    nameEn: current.nameEn,
    code: current.code ?? "",
    baseUnit: current.baseUnit,
    barcode: current.barcode ?? "",
    salePrice: current.salePrice,
    wholesalePrice: current.wholesalePrice,
    taxCodeId: current.taxCodeId,
    egsCode: current.egsCode,
    pack: current.pack && { ...current.pack, barcode: current.pack.barcode ?? "" },
    ...changes,
  };
  const item = cleanItem(db, merged);
  assertFree(db, item, id);
  db.prepare("UPDATE items SET name_ar = ?, name_en = ?, code = ?, tax_code_id = ?, egs_code = ? WHERE id = ?").run(
    item.nameAr,
    item.nameEn,
    item.code,
    item.taxCodeId,
    item.egsCode,
    id,
  );
  writeUnits(db, id, item);
}

export function setItemActive(db: Database.Database, id: number, active: boolean): void {
  findItem(db, id);
  db.prepare("UPDATE items SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
}

/** What a scanned barcode rings up: the item, which unit, and how much stock that unit is. Active items only. */
export function findByBarcode(db: Database.Database, barcode: string): ScannedUnit | null {
  const row = db
    .prepare(
      `SELECT i.id AS itemId, i.name_ar AS nameAr, u.kind AS unit, u.name AS unitName, u.size AS quantity,
              u.sale_price AS salePrice, i.tax_code_id AS taxCodeId, i.serialised
         FROM item_units u JOIN items i ON i.id = u.item_id
        WHERE u.barcode = ? AND i.active = 1`,
    )
    .get(barcode.trim()) as (Omit<ScannedUnit, "serialised"> & { serialised: number }) | undefined;
  return row ? { ...row, serialised: row.serialised === 1 } : null;
}
