import type Database from "better-sqlite3";
import { assertIsoDate } from "./dates";
import { BusinessError } from "./errors";
import type { BasisPoints } from "./items";
import type { IsoDate, Piastres } from "./ledger";
import type { PartyKind } from "./settlements";

/**
 * Egyptian withholding tax (الخصم والإضافة): a share of a payment held back by the payer
 * and paid to the tax authority on the payee's behalf, at a rate set by what is being paid for.
 */
export type WithholdingCategory = {
  id: number;
  name: string;
  rates: { from: IsoDate; rate: BasisPoints }[];
};
/** Withholding on one payment: the category and the value it is taken on (the documents' value before VAT). */
export type WithholdingInput = { categoryId: number; base: Piastres };
export type WithholdingRow = {
  /** "supplier": we withheld and owe it to the authority. "customer": the customer withheld and we hold a credit. */
  kind: PartyKind;
  date: IsoDate;
  number: number;
  partyName: string;
  taxRegistrationNumber: string;
  category: string;
  rate: BasisPoints;
  base: Piastres;
  tax: Piastres;
};
export type WithholdingReport = {
  from: IsoDate;
  to: IsoDate;
  rows: WithholdingRow[];
  withheld: Piastres;
  suffered: Piastres;
};

const WHOLE = 10_000;

export function listWithholdingCategories(db: Database.Database): WithholdingCategory[] {
  const rates = db.prepare('SELECT effective_from AS "from", rate FROM withholding_rates WHERE category_id = ? ORDER BY effective_from');
  return (db.prepare("SELECT id, name FROM withholding_categories ORDER BY id").all() as { id: number; name: string }[]).map((c) => ({
    ...c,
    rates: rates.all(c.id) as WithholdingCategory["rates"],
  }));
}

export function assertWithholdingCategory(db: Database.Database, id: number | null): void {
  if (id !== null && !db.prepare("SELECT 1 FROM withholding_categories WHERE id = ?").get(id)) {
    throw new BusinessError("withholding_category_not_found", `No withholding category with id ${id}`);
  }
}

export function addWithholdingRate(db: Database.Database, categoryId: number, input: { from: IsoDate; rate: BasisPoints }): void {
  assertWithholdingCategory(db, categoryId);
  assertIsoDate(input.from);
  if (!Number.isInteger(input.rate) || input.rate < 0 || input.rate > WHOLE) {
    throw new BusinessError("tax_rate_invalid", `Rate ${input.rate} is not between 0 and 10000 basis points`);
  }
  db.prepare("INSERT INTO withholding_rates (category_id, effective_from, rate) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET rate = excluded.rate").run(
    categoryId,
    input.from,
    input.rate,
  );
}

export function withholdingRate(db: Database.Database, categoryId: number, date: IsoDate): BasisPoints {
  assertWithholdingCategory(db, categoryId);
  assertIsoDate(date);
  const row = db
    .prepare("SELECT rate FROM withholding_rates WHERE category_id = ? AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1")
    .get(categoryId, date) as { rate: number } | undefined;
  if (!row) throw new BusinessError("tax_rate_missing", `No withholding rate in force on ${date} for category ${categoryId}`);
  return row.rate;
}

/** The tax on `base` at the category's rate on `date`, rounded half-up to the piastre. */
export function withholdingTax(db: Database.Database, categoryId: number, date: IsoDate, base: Piastres): Piastres {
  if (!Number.isSafeInteger(base) || base < 0) throw new BusinessError("withholding_invalid", `Base ${base} is not whole piastres`);
  return Math.round((base * withholdingRate(db, categoryId, date)) / WHOLE);
}

/** Withholding taken on payments between two dates, both directions, for the quarterly form. */
export function withholdingReport(db: Database.Database, from: IsoDate, to: IsoDate): WithholdingReport {
  assertIsoDate(from);
  assertIsoDate(to);
  if (from > to) throw new BusinessError("date_range_invalid", `${from} is after ${to}`);
  const rows = db
    .prepare(
      `SELECT p.kind, p.date, p.number, COALESCE(c.name, s.name) AS partyName,
              COALESCE(c.tax_registration_number, s.tax_registration_number) AS taxRegistrationNumber,
              w.name AS category, p.withholding_rate AS rate, p.withholding_base AS base, p.withholding_amount AS tax
         FROM payments p JOIN withholding_categories w ON w.id = p.withholding_category_id
         LEFT JOIN customers c ON c.id = p.customer_id LEFT JOIN suppliers s ON s.id = p.supplier_id
        WHERE p.date BETWEEN ? AND ?
        ORDER BY p.date, p.id`,
    )
    .all(from, to) as WithholdingRow[];
  const total = (kind: PartyKind) => rows.filter((r) => r.kind === kind).reduce((t, r) => t + r.tax, 0);
  return {
    from,
    to,
    rows,
    withheld: total("supplier"),
    suffered: total("customer"),
  };
}
