import type Database from "better-sqlite3";
import { findCustomer } from "./customers";
import { assertIsoDate } from "./dates";
import { BusinessError } from "./errors";
import type { Quantity } from "./items";
import { vatRate } from "./items";
import type { IsoDate, Piastres } from "./ledger";
import { type InvoiceLine, type InvoiceLineInput, priceInvoice } from "./invoices";
import { vatRegistered } from "./purchases";
import { nextNumber } from "./shares";

const WHOLE = 10_000;

export type QuotationLineInput = Omit<InvoiceLineInput, "serials">;
export type QuotationInput = {
  date: IsoDate;
  /** The last day the prices stand. */
  validUntil: IsoDate;
  customerId: number;
  /** The customer's request number or similar. */
  reference: string;
  notes: string;
  lines: QuotationLineInput[];
};
export type QuotationStatus = "open" | "expired" | "converted";
export type Quotation = {
  id: number;
  number: number;
  date: IsoDate;
  validUntil: IsoDate;
  customerId: number;
  customerName: string;
  reference: string;
  notes: string;
  preparedBy: string;
  status: QuotationStatus;
  /** The sales invoice it became, once converted. */
  invoiceNumber: number | null;
  gross: Piastres;
  discount: Piastres;
  net: Piastres;
  vat: Piastres;
  total: Piastres;
  lines: (InvoiceLine & { nameAr: string; unitName: string })[];
};

/**
 * The VAT-exclusive price of one unit for a customer: the wholesale price for wholesale
 * customers when the item has one, otherwise the retail price, with VAT taken off half-up.
 */
export function listPrice(db: Database.Database, customerId: number | null, itemId: number, unit: "base" | "pack", date: IsoDate): Piastres {
  const level = customerId === null ? "retail" : findCustomer(db, customerId).priceLevel;
  const row = db
    .prepare("SELECT u.sale_price AS retail, u.wholesale_price AS wholesale, i.tax_code_id AS taxCodeId FROM item_units u JOIN items i ON i.id = u.item_id WHERE u.item_id = ? AND u.kind = ?")
    .get(itemId, unit) as { retail: number; wholesale: number | null; taxCodeId: number } | undefined;
  if (!row) throw new BusinessError("item_not_found", `No ${unit} unit for item ${itemId}`);
  const inclusive = level === "wholesale" && row.wholesale !== null ? row.wholesale : row.retail;
  const rate = vatRate(db, row.taxCodeId, date, vatRegistered(db));
  return Math.round((inclusive * WHOLE) / (WHOLE + rate));
}

/** Saves a quotation. It is priced like an invoice but posts nothing and moves no stock. */
export function saveQuotation(db: Database.Database, input: QuotationInput, userId: number): { id: number; number: number } {
  assertIsoDate(input.date);
  assertIsoDate(input.validUntil);
  if (input.validUntil < input.date) throw new BusinessError("date_range_invalid", `Valid until ${input.validUntil} is before ${input.date}`);
  const customer = findCustomer(db, input.customerId);
  if (!customer.active) throw new BusinessError("customer_inactive", `Customer ${customer.name} is stopped`);
  if (input.lines.length === 0) throw new BusinessError("invoice_needs_lines", "A quotation needs at least one line");
  const priced = priceInvoice(db, input.date, input.lines);
  const number = nextNumber(db, "quotations");
  const id = Number(
    db
      .prepare("INSERT INTO quotations (number, date, valid_until, customer_id, reference, notes, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(number, input.date, input.validUntil, customer.id, input.reference.trim(), input.notes.trim(), userId).lastInsertRowid,
  );
  const insert = db.prepare("INSERT INTO quotation_lines (quotation_id, item_id, unit, quantity, unit_price, discount) VALUES (?, ?, ?, ?, ?, ?)");
  for (const l of priced.lines) insert.run(id, l.itemId, l.unit, l.quantity, l.unitPrice, l.discount);
  return { id, number };
}

/** Marks a quotation as turned into an invoice; called inside the invoice's transaction. */
export function convertQuotation(db: Database.Database, quotationId: number, customerId: number, invoiceId: number): void {
  const row = db.prepare("SELECT customer_id AS customerId, invoice_id AS invoiceId FROM quotations WHERE id = ?").get(quotationId) as
    | { customerId: number; invoiceId: number | null }
    | undefined;
  if (!row) throw new BusinessError("quotation_not_found", `No quotation with id ${quotationId}`);
  if (row.invoiceId !== null) throw new BusinessError("quotation_converted", `Quotation ${quotationId} is already an invoice`);
  if (row.customerId !== customerId) throw new BusinessError("quotation_customer_mismatch", `Quotation ${quotationId} is for another customer`);
  db.prepare("UPDATE quotations SET invoice_id = ? WHERE id = ?").run(invoiceId, quotationId);
}

type QuotationRow = Omit<Quotation, "status" | "gross" | "discount" | "net" | "vat" | "total" | "lines">;
const SELECT = `
  SELECT q.id, q.number, q.date, q.valid_until AS validUntil, q.customer_id AS customerId, c.name AS customerName,
         q.reference, q.notes, u.name AS preparedBy, s.number AS invoiceNumber
    FROM quotations q JOIN customers c ON c.id = q.customer_id JOIN users u ON u.id = q.user_id
    LEFT JOIN sales_invoices s ON s.id = q.invoice_id`;

function withLines(db: Database.Database, r: QuotationRow, today: IsoDate): Quotation {
  const stored = db
    .prepare(
      `SELECT l.item_id AS itemId, i.name_ar AS nameAr, l.unit, u.name AS unitName, l.quantity, l.unit_price AS unitPrice, l.discount
         FROM quotation_lines l JOIN items i ON i.id = l.item_id JOIN item_units u ON u.item_id = l.item_id AND u.kind = l.unit
        WHERE l.quotation_id = ? ORDER BY l.id`,
    )
    .all(r.id) as (QuotationLineInput & { nameAr: string; unitName: string; quantity: Quantity })[];
  const priced = priceInvoice(db, r.date, stored);
  const status: QuotationStatus = r.invoiceNumber !== null ? "converted" : r.validUntil < today ? "expired" : "open";
  return {
    ...r,
    status,
    gross: priced.gross,
    discount: priced.discount,
    net: priced.net,
    vat: priced.vat,
    total: priced.total,
    lines: priced.lines.map((l, i) => ({ ...l, nameAr: stored[i]!.nameAr, unitName: stored[i]!.unitName })),
  };
}

/** Quotations, newest first, with their status on `today`. */
export function listQuotations(db: Database.Database, today: IsoDate): Quotation[] {
  assertIsoDate(today);
  return (db.prepare(`${SELECT} ORDER BY q.number DESC`).all() as QuotationRow[]).map((r) => withLines(db, r, today));
}

export function findQuotation(db: Database.Database, number: number, today: IsoDate): Quotation {
  assertIsoDate(today);
  const row = db.prepare(`${SELECT} WHERE q.number = ?`).get(number) as QuotationRow | undefined;
  if (!row) throw new BusinessError("quotation_not_found", `No quotation number ${number}`);
  return withLines(db, row, today);
}
