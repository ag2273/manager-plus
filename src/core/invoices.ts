import type Database from "better-sqlite3";
import { type CreditApproval, checkCreditLimit, findCustomer } from "./customers";
import { findUser } from "./users";
import { assertIsoDate } from "./dates";
import { BusinessError } from "./errors";
import { type BasisPoints, type Quantity, vatRate } from "./items";
import { type IsoDate, type JournalLine, type Piastres, postJournalEntry } from "./ledger";
import { vatRegistered } from "./purchases";
import { convertQuotation } from "./quotations";
import { type Taken, nextNumber, shareOf, take } from "./shares";
import { issueSerials, returnSerials, serialsFor, serialsOnLine, warrantyEnd } from "./serials";
import { type SerialLine, type UnitLine, accountByRole, activeWarehouse, assertQuantity, costOfIssue, insertMovement, toBaseQuantity } from "./stock";

/** An invoice line: price per one of the chosen unit and a discount in piastres, both VAT-exclusive. */
export type InvoiceLineInput = UnitLine & SerialLine & { unitPrice: Piastres; discount?: Piastres };
export type InvoiceLine = UnitLine & {
  unitPrice: Piastres;
  /** Quantity × unit price. */
  gross: Piastres;
  discount: Piastres;
  net: Piastres;
  vatRate: BasisPoints;
  vat: Piastres;
};
export type PricedInvoice = { lines: InvoiceLine[]; gross: Piastres; discount: Piastres; net: Piastres; vat: Piastres; total: Piastres };
export type SalesInvoiceInput = {
  date: IsoDate;
  customerId: number;
  warehouseId: number;
  /** The customer's order number or similar. */
  reference: string;
  notes: string;
  lines: InvoiceLineInput[];
  /** The quotation this invoice comes from; it is marked converted. */
  quotationId?: number;
  /** A manager's sign-in when the invoice takes the customer past their credit limit. */
  creditApproval?: CreditApproval;
};
export type SalesInvoiceResult = { id: number; number: number; total: Piastres; belowZero: number[] };
export type SalesInvoice = {
  id: number;
  number: number;
  date: IsoDate;
  customerId: number;
  customerName: string;
  warehouseId: number;
  reference: string;
  notes: string;
  postedBy: string;
  gross: Piastres;
  discount: Piastres;
  net: Piastres;
  vat: Piastres;
  total: Piastres;
  /** The total of credit notes against the invoice. */
  credited: Piastres;
  creditNotes: { number: number; date: IsoDate; total: Piastres }[];
  lines: (InvoiceLine & { lineId: number; nameAr: string; nameEn: string; unitName: string; credited: Quantity; serials: string[]; warrantyEnds: IsoDate | null })[];
};
export type CreditNoteInput = {
  date: IsoDate;
  invoiceId: number;
  reason: string;
  /** Invoice lines and how much of each comes back, in thousandths of the line's unit. */
  lines: { lineId: number; quantity: Quantity; serials?: string[] }[];
};
export type CreditNote = {
  id: number;
  number: number;
  date: IsoDate;
  invoiceNumber: number;
  customerId: number;
  customerName: string;
  reason: string;
  postedBy: string;
  net: Piastres;
  vat: Piastres;
  total: Piastres;
  lines: { itemId: number; nameAr: string; nameEn: string; unit: "base" | "pack"; unitName: string; quantity: Quantity; unitPrice: Piastres; net: Piastres; vat: Piastres }[];
};

const ONE_UNIT = 1000;
const WHOLE = 10_000;

/** Prices invoice lines without posting: net = quantity × price − discount, VAT on net, rounded half-up per line. */
export function priceInvoice(db: Database.Database, date: IsoDate, lines: InvoiceLineInput[]): PricedInvoice {
  assertIsoDate(date);
  const registered = vatRegistered(db);
  const taxCodeOf = db.prepare("SELECT tax_code_id AS id FROM items WHERE id = ?");
  const priced = lines.map((line) => {
    assertQuantity(line.quantity);
    toBaseQuantity(db, line);
    if (!Number.isSafeInteger(line.unitPrice) || line.unitPrice < 0) {
      throw new BusinessError("price_invalid", `Unit price ${line.unitPrice} is not whole piastres`);
    }
    const gross = Math.round((line.quantity * line.unitPrice) / ONE_UNIT);
    const discount = line.discount ?? 0;
    if (!Number.isSafeInteger(discount) || discount < 0 || discount > gross) {
      throw new BusinessError("discount_invalid", `Discount ${discount} does not fit a line of ${gross}`);
    }
    const net = gross - discount;
    const rate = vatRate(db, (taxCodeOf.get(line.itemId) as { id: number }).id, date, registered);
    return { itemId: line.itemId, unit: line.unit, quantity: line.quantity, unitPrice: line.unitPrice, gross, discount, net, vatRate: rate, vat: Math.round((net * rate) / WHOLE) };
  });
  const sum = (pick: (l: InvoiceLine) => number) => priced.reduce((t, l) => t + pick(l), 0);
  const net = sum((l) => l.net);
  const vat = sum((l) => l.vat);
  return { lines: priced, gross: sum((l) => l.gross), discount: sum((l) => l.discount), net, vat, total: net + vat };
}

/**
 * A tax invoice on the customer's account: Dr Receivables (tagged with the customer),
 * Cr Sales and Output VAT; Dr Cost of goods sold, Cr Stock at average cost.
 */
export function postSalesInvoice(db: Database.Database, input: SalesInvoiceInput, userId: number): SalesInvoiceResult {
  const customer = findCustomer(db, input.customerId);
  if (!customer.active) throw new BusinessError("customer_inactive", `Customer ${customer.name} is stopped`);
  activeWarehouse(db, input.warehouseId);
  if (input.lines.length === 0) throw new BusinessError("invoice_needs_lines", "An invoice needs at least one line");
  const priced = priceInvoice(db, input.date, input.lines);
  if (priced.total === 0) throw new BusinessError("invoice_total_zero", "The invoice total is zero");
  checkCreditLimit(db, customer, priced.total, input.creditApproval, { document: "postSalesInvoice", requestedBy: findUser(db, userId).name });

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

  const number = nextNumber(db, "sales_invoices");
  const journal: JournalLine[] = [{ accountId: accountByRole(db, "receivables"), debit: priced.total, customerId: customer.id }];
  if (priced.net > 0) journal.push({ accountId: accountByRole(db, "sales"), credit: priced.net });
  if (priced.vat > 0) journal.push({ accountId: accountByRole(db, "output_vat"), credit: priced.vat });
  if (totalCost > 0) {
    journal.push({ accountId: accountByRole(db, "cost_of_goods_sold"), debit: totalCost });
    journal.push({ accountId: accountByRole(db, "stock"), credit: totalCost });
  }
  const entryId = postJournalEntry(db, { date: input.date, memo: `فاتورة مبيعات رقم ${number} - ${customer.name}`, lines: journal }, "sales_invoice");
  const id = Number(
    db
      .prepare(
        `INSERT INTO sales_invoices (number, date, customer_id, warehouse_id, reference, notes, entry_id, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(number, input.date, customer.id, input.warehouseId, input.reference.trim(), input.notes.trim(), entryId, userId).lastInsertRowid,
  );
  if (input.quotationId !== undefined) convertQuotation(db, input.quotationId, customer.id, id);
  const insertLine = db.prepare(
    `INSERT INTO sales_invoice_lines (invoice_id, item_id, unit, quantity, unit_price, discount, net, vat_rate, vat, cost)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const { line: l, base, cost, serials } of outs) {
    const lineId = Number(insertLine.run(id, l.itemId, l.unit, l.quantity, l.unitPrice, l.discount, l.net, l.vatRate, l.vat, cost).lastInsertRowid);
    issueSerials(db, l.itemId, serials, { date: input.date, warehouseId: input.warehouseId, source: "sales_invoice", sourceId: id, lineId });
    insertMovement(db, { date: input.date, itemId: l.itemId, warehouseId: input.warehouseId, quantity: -base, value: -cost, source: "sales_invoice", sourceId: id });
  }
  const held = db.prepare("SELECT COALESCE(SUM(quantity), 0) AS q FROM stock_movements WHERE item_id = ? AND warehouse_id = ?");
  const belowZero = [...taken.keys()].filter((itemId) => (held.get(itemId, input.warehouseId) as { q: number }).q < 0);
  return { id, number, total: priced.total, belowZero };
}

type InvoiceRow = Omit<SalesInvoice, "gross" | "discount" | "net" | "vat" | "total" | "credited" | "creditNotes" | "lines">;
const SELECT_INVOICES = `
  SELECT s.id, s.number, s.date, s.customer_id AS customerId, c.name AS customerName, s.warehouse_id AS warehouseId,
         s.reference, s.notes, u.name AS postedBy
    FROM sales_invoices s JOIN customers c ON c.id = s.customer_id JOIN users u ON u.id = s.user_id`;

function toInvoices(db: Database.Database, rows: InvoiceRow[]): SalesInvoice[] {
  const lines = db.prepare(
    `SELECT l.id AS lineId, l.item_id AS itemId, i.name_ar AS nameAr, i.name_en AS nameEn, l.unit, u.name AS unitName, l.quantity, l.unit_price AS unitPrice,
            l.net + l.discount AS gross, l.discount, l.net, l.vat_rate AS vatRate, l.vat,
            COALESCE((SELECT SUM(x.quantity) FROM credit_note_lines x WHERE x.invoice_line_id = l.id), 0) AS credited
       FROM sales_invoice_lines l JOIN items i ON i.id = l.item_id JOIN item_units u ON u.item_id = l.item_id AND u.kind = l.unit
      WHERE l.invoice_id = ? ORDER BY l.id`,
  );
  const notes = db.prepare(
    `SELECT n.number, n.date, (SELECT SUM(x.net + x.vat) FROM credit_note_lines x WHERE x.note_id = n.id) AS total
       FROM credit_notes n WHERE n.invoice_id = ? ORDER BY n.number`,
  );
  return rows.map((r) => {
    const ls = (lines.all(r.id) as Omit<SalesInvoice["lines"][number], "serials" | "warrantyEnds">[]).map((l) => {
      const serials = serialsOnLine(db, "sales_invoice", r.id, l.lineId);
      return { ...l, serials, warrantyEnds: serials.length > 0 ? warrantyEnd(db, l.itemId, r.date) : null };
    });
    const creditNotes = notes.all(r.id) as SalesInvoice["creditNotes"];
    const sum = (pick: (l: SalesInvoice["lines"][number]) => number) => ls.reduce((t, l) => t + pick(l), 0);
    const net = sum((l) => l.net);
    const vat = sum((l) => l.vat);
    return {
      ...r,
      gross: sum((l) => l.gross),
      discount: sum((l) => l.discount),
      net,
      vat,
      total: net + vat,
      credited: creditNotes.reduce((t, n) => t + n.total, 0),
      creditNotes,
      lines: ls,
    };
  });
}

/** Sales invoices, newest first. */
export function listSalesInvoices(db: Database.Database, limit = 200): SalesInvoice[] {
  return toInvoices(db, db.prepare(`${SELECT_INVOICES} ORDER BY s.number DESC LIMIT ?`).all(limit) as InvoiceRow[]);
}

/** One invoice by its printed number. */
export function findSalesInvoice(db: Database.Database, number: number): SalesInvoice {
  const row = db.prepare(`${SELECT_INVOICES} WHERE s.number = ?`).get(number) as InvoiceRow | undefined;
  if (!row) throw new BusinessError("invoice_not_found", `No sales invoice number ${number}`);
  return toInvoices(db, [row])[0]!;
}

type InvoicedLine = { id: number; itemId: number; unit: "base" | "pack"; quantity: number; net: number; vat: number; cost: number; size: number };

/**
 * Goods back from a customer against their invoice, at the invoice's price, VAT and
 * cost: Dr Sales, Dr Output VAT, Cr Receivables; Dr Stock, Cr Cost of goods sold;
 * stock back into the warehouse it left from.
 */
export function postCreditNote(db: Database.Database, input: CreditNoteInput, userId: number): { id: number; number: number; total: Piastres } {
  assertIsoDate(input.date);
  const invoice = db
    .prepare("SELECT id, number, customer_id AS customerId, warehouse_id AS warehouseId FROM sales_invoices WHERE id = ?")
    .get(input.invoiceId) as { id: number; number: number; customerId: number; warehouseId: number } | undefined;
  if (!invoice) throw new BusinessError("invoice_not_found", `No sales invoice with id ${input.invoiceId}`);
  if (input.lines.length === 0) throw new BusinessError("invoice_needs_lines", "A credit note needs at least one line");

  const invoiced = db.prepare(
    `SELECT l.id, l.item_id AS itemId, l.unit, l.quantity, l.net, l.vat, l.cost, COALESCE(u.size, 1000) AS size
       FROM sales_invoice_lines l LEFT JOIN item_units u ON u.item_id = l.item_id AND u.kind = l.unit
      WHERE l.id = ? AND l.invoice_id = ?`,
  );
  const creditedBefore = db.prepare(
    `SELECT COALESCE(SUM(quantity), 0) AS quantity, COALESCE(SUM(net), 0) AS net, COALESCE(SUM(vat), 0) AS vat, COALESCE(SUM(cost), 0) AS cost
       FROM credit_note_lines WHERE invoice_line_id = ?`,
  );
  const taken = new Map<number, Taken>();
  const backs = input.lines.map(({ lineId, quantity, serials: given }) => {
    assertQuantity(quantity);
    const line = invoiced.get(lineId, invoice.id) as InvoicedLine | undefined;
    if (!line) throw new BusinessError("return_line_invalid", `Line ${lineId} is not on invoice ${invoice.number}`);
    const stored = creditedBefore.get(lineId) as { quantity: number; net: number; vat: number; cost: number };
    const before = taken.get(lineId) ?? { quantity: stored.quantity, values: [stored.net, stored.vat, stored.cost] };
    if (before.quantity + quantity > line.quantity) {
      throw new BusinessError("return_exceeds_sale", `Only ${line.quantity - before.quantity} of line ${lineId} can still be credited`);
    }
    const share = shareOf([line.net, line.vat, line.cost], line.quantity, before, quantity);
    taken.set(lineId, take(before, quantity, share));
    const [net, vat, cost] = share as [number, number, number];
    const base = Math.round((quantity * line.size) / ONE_UNIT);
    return { line, quantity, base, net, vat, cost, serials: serialsFor(db, line.itemId, base, given) };
  });
  const net = backs.reduce((t, b) => t + b.net, 0);
  const vat = backs.reduce((t, b) => t + b.vat, 0);
  const cost = backs.reduce((t, b) => t + b.cost, 0);
  const total = net + vat;
  const number = nextNumber(db, "credit_notes");

  const journal: JournalLine[] = [];
  if (net > 0) journal.push({ accountId: accountByRole(db, "sales"), debit: net });
  if (vat > 0) journal.push({ accountId: accountByRole(db, "output_vat"), debit: vat });
  if (total > 0) journal.push({ accountId: accountByRole(db, "receivables"), credit: total, customerId: invoice.customerId });
  if (cost > 0) {
    journal.push({ accountId: accountByRole(db, "stock"), debit: cost });
    journal.push({ accountId: accountByRole(db, "cost_of_goods_sold"), credit: cost });
  }
  const entryId = postJournalEntry(db, { date: input.date, memo: `إشعار دائن رقم ${number} على فاتورة ${invoice.number}`, lines: journal }, "credit_note");
  const id = Number(
    db
      .prepare("INSERT INTO credit_notes (number, date, invoice_id, reason, entry_id, user_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run(number, input.date, invoice.id, input.reason.trim(), entryId, userId).lastInsertRowid,
  );
  const insertLine = db.prepare("INSERT INTO credit_note_lines (note_id, invoice_line_id, quantity, net, vat, cost) VALUES (?, ?, ?, ?, ?, ?)");
  for (const b of backs) {
    const lineId = Number(insertLine.run(id, b.line.id, b.quantity, b.net, b.vat, b.cost).lastInsertRowid);
    returnSerials(db, b.line.itemId, b.serials, { source: "sales_invoice", sourceId: invoice.id }, { date: input.date, warehouseId: invoice.warehouseId, source: "credit_note", sourceId: id, lineId });
    insertMovement(db, { date: input.date, itemId: b.line.itemId, warehouseId: invoice.warehouseId, quantity: b.base, value: b.cost, source: "credit_note", sourceId: id });
  }
  return { id, number, total };
}

/** One credit note by its printed number. */
export function findCreditNote(db: Database.Database, number: number): CreditNote {
  const row = db
    .prepare(
      `SELECT n.id, n.number, n.date, s.number AS invoiceNumber, s.customer_id AS customerId, c.name AS customerName,
              n.reason, u.name AS postedBy
         FROM credit_notes n JOIN sales_invoices s ON s.id = n.invoice_id
         JOIN customers c ON c.id = s.customer_id JOIN users u ON u.id = n.user_id
        WHERE n.number = ?`,
    )
    .get(number) as Omit<CreditNote, "lines" | "net" | "vat" | "total"> | undefined;
  if (!row) throw new BusinessError("invoice_not_found", `No credit note number ${number}`);
  const lines = db
    .prepare(
      `SELECT l.item_id AS itemId, i.name_ar AS nameAr, i.name_en AS nameEn, l.unit, u.name AS unitName, x.quantity, l.unit_price AS unitPrice, x.net, x.vat
         FROM credit_note_lines x JOIN sales_invoice_lines l ON l.id = x.invoice_line_id JOIN items i ON i.id = l.item_id
         JOIN item_units u ON u.item_id = l.item_id AND u.kind = l.unit
        WHERE x.note_id = ? ORDER BY x.id`,
    )
    .all(row.id) as CreditNote["lines"];
  const net = lines.reduce((t, l) => t + l.net, 0);
  const vat = lines.reduce((t, l) => t + l.vat, 0);
  return { ...row, lines, net, vat, total: net + vat };
}
