import type Database from "better-sqlite3";
import { toEgp } from "./currency";
import { assertIsoDate } from "./dates";
import { BusinessError } from "./errors";
import type { Quantity } from "./items";
import { type IsoDate, type JournalLine, type Piastres, postJournalEntry } from "./ledger";
import { findSupplier } from "./purchases";
import { type Taken, nextNumber, shareOf, take } from "./shares";
import { issueSerials, serialsFor } from "./serials";
import { accountByRole, assertQuantity, insertMovement } from "./stock";

export type DebitNoteInput = {
  date: IsoDate;
  purchaseInvoiceId: number;
  reason: string;
  /** Purchase invoice lines and how much of each goes back, in thousandths of the line's unit. */
  lines: { lineId: number; quantity: Quantity; serials?: string[] }[];
};
export type DebitNote = {
  id: number;
  number: number;
  date: IsoDate;
  purchaseInvoiceId: number;
  supplierId: number;
  reason: string;
  postedBy: string;
  net: Piastres;
  vat: Piastres;
  total: Piastres;
  lines: { itemId: number; nameAr: string; unit: "base" | "pack"; quantity: Quantity; net: Piastres; vat: Piastres }[];
};

type BoughtLine = { id: number; itemId: number; unit: "base" | "pack"; quantity: number; net: number; vat: number; size: number };

const ONE_UNIT = 1000;

/**
 * Goods sent back to a supplier against their invoice, at that invoice's cost and VAT:
 * Dr Payables (tagged with the supplier), Cr Stock, Cr Input VAT; stock out of the
 * warehouse the goods came into.
 */
export function postDebitNote(db: Database.Database, input: DebitNoteInput, userId: number): { id: number; number: number; total: Piastres } {
  assertIsoDate(input.date);
  const invoice = db
    .prepare("SELECT id, supplier_id AS supplierId, warehouse_id AS warehouseId, reference, currency, rate FROM purchase_invoices WHERE id = ?")
    .get(input.purchaseInvoiceId) as { id: number; supplierId: number; warehouseId: number; reference: string; currency: string; rate: number } | undefined;
  if (!invoice) throw new BusinessError("invoice_not_found", `No purchase invoice with id ${input.purchaseInvoiceId}`);
  const supplier = findSupplier(db, invoice.supplierId);
  if (input.lines.length === 0) throw new BusinessError("invoice_needs_lines", "A debit note needs at least one line");

  const bought = db.prepare(
    `SELECT l.id, l.item_id AS itemId, l.unit, l.quantity, l.net, l.vat, COALESCE(u.size, 1000) AS size
       FROM purchase_invoice_lines l LEFT JOIN item_units u ON u.item_id = l.item_id AND u.kind = l.unit
      WHERE l.id = ? AND l.invoice_id = ?`,
  );
  const returnedBefore = db.prepare(
    "SELECT COALESCE(SUM(quantity), 0) AS quantity, COALESCE(SUM(net), 0) AS net, COALESCE(SUM(vat), 0) AS vat FROM debit_note_lines WHERE purchase_line_id = ?",
  );
  const taken = new Map<number, Taken>();
  const backs = input.lines.map(({ lineId, quantity, serials: given }) => {
    assertQuantity(quantity);
    const line = bought.get(lineId, invoice.id) as BoughtLine | undefined;
    if (!line) throw new BusinessError("return_line_invalid", `Line ${lineId} is not on purchase invoice ${invoice.id}`);
    const stored = returnedBefore.get(lineId) as { quantity: number; net: number; vat: number };
    const before = taken.get(lineId) ?? { quantity: stored.quantity, values: [stored.net, stored.vat] };
    if (before.quantity + quantity > line.quantity) {
      throw new BusinessError("return_exceeds_sale", `Only ${line.quantity - before.quantity} of line ${lineId} can still go back`);
    }
    const share = shareOf([line.net, line.vat], line.quantity, before, quantity);
    taken.set(lineId, take(before, quantity, share));
    const [net, vat] = share as [number, number];
    const base = Math.round((quantity * line.size) / ONE_UNIT);
    const netEgp = toEgp(net, invoice.rate);
    return { line, quantity, base, net, vat, netEgp, vatEgp: toEgp(vat, invoice.rate), serials: serialsFor(db, line.itemId, base, given) };
  });
  // Amounts on the note are in the invoice's currency; the books take them at the invoice's rate.
  const net = backs.reduce((t, b) => t + b.net, 0);
  const vat = backs.reduce((t, b) => t + b.vat, 0);
  const netEgp = backs.reduce((t, b) => t + b.netEgp, 0);
  const vatEgp = backs.reduce((t, b) => t + b.vatEgp, 0);
  const number = nextNumber(db, "debit_notes");

  const journal: JournalLine[] = [];
  const foreign = invoice.currency === "EGP" ? {} : { foreign: net + vat };
  if (netEgp + vatEgp > 0) journal.push({ accountId: accountByRole(db, "payables"), debit: netEgp + vatEgp, supplierId: supplier.id, ...foreign });
  if (netEgp > 0) journal.push({ accountId: accountByRole(db, "stock"), credit: netEgp });
  if (vatEgp > 0) journal.push({ accountId: accountByRole(db, "input_vat"), credit: vatEgp });
  const memo = `إشعار مدين رقم ${number} - مرتجع إلى ${supplier.name}${invoice.reference ? ` فاتورة ${invoice.reference}` : ""}`;
  const entryId = postJournalEntry(db, { date: input.date, memo, lines: journal }, "debit_note");
  const id = Number(
    db
      .prepare("INSERT INTO debit_notes (number, date, purchase_invoice_id, reason, entry_id, user_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run(number, input.date, invoice.id, input.reason.trim(), entryId, userId).lastInsertRowid,
  );
  const insertLine = db.prepare("INSERT INTO debit_note_lines (note_id, purchase_line_id, quantity, net, vat) VALUES (?, ?, ?, ?, ?)");
  for (const b of backs) {
    const lineId = Number(insertLine.run(id, b.line.id, b.quantity, b.net, b.vat).lastInsertRowid);
    issueSerials(db, b.line.itemId, b.serials, { date: input.date, warehouseId: invoice.warehouseId, source: "debit_note", sourceId: id, lineId });
    insertMovement(db, { date: input.date, itemId: b.line.itemId, warehouseId: invoice.warehouseId, quantity: -b.base, value: -b.netEgp, source: "debit_note", sourceId: id });
  }
  return { id, number, total: net + vat };
}

/** Debit notes, newest first. */
export function listDebitNotes(db: Database.Database): DebitNote[] {
  const rows = db
    .prepare(
      `SELECT n.id, n.number, n.date, n.purchase_invoice_id AS purchaseInvoiceId, p.supplier_id AS supplierId, n.reason, u.name AS postedBy
         FROM debit_notes n JOIN purchase_invoices p ON p.id = n.purchase_invoice_id JOIN users u ON u.id = n.user_id
        ORDER BY n.number DESC`,
    )
    .all() as Omit<DebitNote, "lines" | "net" | "vat" | "total">[];
  const lines = db.prepare(
    `SELECT l.item_id AS itemId, i.name_ar AS nameAr, l.unit, x.quantity, x.net, x.vat
       FROM debit_note_lines x JOIN purchase_invoice_lines l ON l.id = x.purchase_line_id JOIN items i ON i.id = l.item_id
      WHERE x.note_id = ? ORDER BY x.id`,
  );
  return rows.map((r) => {
    const ls = lines.all(r.id) as DebitNote["lines"];
    const net = ls.reduce((t, l) => t + l.net, 0);
    const vat = ls.reduce((t, l) => t + l.vat, 0);
    return { ...r, lines: ls, net, vat, total: net + vat };
  });
}
