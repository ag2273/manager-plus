import type Database from "better-sqlite3";
import { assertIsoDate } from "./dates";
import { BusinessError } from "./errors";
import type { IsoDate, Piastres } from "./ledger";
import { vatRegistered } from "./purchases";

export type TaxKind = "standard" | "zero_rated" | "exempt";
export type VatSection = "sales" | "purchases" | "expenses" | "imports";
/** One document's lines under one tax kind: what each figure on the return drills down to. */
export type VatTransaction = {
  section: VatSection;
  taxKind: TaxKind;
  /** sale, sale_return, sales_invoice, credit_note, purchase_invoice, debit_note, expense, expense_void, import_shipment */
  kind: string;
  /** The document's number; a purchase invoice shows the supplier's reference instead. */
  number: string;
  date: IsoDate;
  party: string;
  net: Piastres;
  vat: Piastres;
  entryId: number;
};
export type VatBox = { section: VatSection; taxKind: TaxKind; net: Piastres; vat: Piastres };
export type VatReturn = {
  from: IsoDate;
  to: IsoDate;
  /** Sales and purchases per tax kind, then expenses and VAT paid at customs; empty boxes left out. */
  boxes: VatBox[];
  outputVat: Piastres;
  inputVat: Piastres;
  /**
   * What the VAT accounts moved by in the period beyond the documents above, such as journal
   * entries posted straight to them. Zero when everything went through documents.
   */
  outputAdjustments: Piastres;
  inputAdjustments: Piastres;
  /** Output less input, adjustments included; negative is VAT to carry forward. */
  netDue: Piastres;
  transactions: VatTransaction[];
};

/**
 * The tax kind of a line: anything that carried VAT is standard-rated; a line at 0% takes its
 * item's kind, so zero-rated and exempt sales stay apart.
 */
const KIND = (rate: string) => `CASE WHEN ${rate} > 0 THEN 'standard' ELSE t.kind END`;

const TRANSACTIONS = `
  SELECT 'sales' AS section, ${KIND("l.vat_rate")} AS taxKind, 'sale' AS kind, CAST(r.number AS TEXT) AS number, r.date, '' AS party,
         SUM(l.net) AS net, SUM(l.vat) AS vat, r.entry_id AS entryId
    FROM sales_receipt_lines l JOIN sales_receipts r ON r.id = l.receipt_id JOIN items i ON i.id = l.item_id JOIN tax_codes t ON t.id = i.tax_code_id
   GROUP BY r.id, ${KIND("l.vat_rate")}
  UNION ALL
  SELECT 'sales', ${KIND("o.vat_rate")}, 'sale_return', CAST(x.number AS TEXT), x.date, '', -SUM(l.net), -SUM(l.vat), x.entry_id
    FROM sales_return_lines l JOIN sales_returns x ON x.id = l.return_id JOIN sales_receipt_lines o ON o.id = l.receipt_line_id
    JOIN items i ON i.id = o.item_id JOIN tax_codes t ON t.id = i.tax_code_id
   GROUP BY x.id, ${KIND("o.vat_rate")}
  UNION ALL
  SELECT 'sales', ${KIND("l.vat_rate")}, 'sales_invoice', CAST(s.number AS TEXT), s.date, c.name, SUM(l.net), SUM(l.vat), s.entry_id
    FROM sales_invoice_lines l JOIN sales_invoices s ON s.id = l.invoice_id JOIN customers c ON c.id = s.customer_id
    JOIN items i ON i.id = l.item_id JOIN tax_codes t ON t.id = i.tax_code_id
   GROUP BY s.id, ${KIND("l.vat_rate")}
  UNION ALL
  SELECT 'sales', ${KIND("o.vat_rate")}, 'credit_note', CAST(n.number AS TEXT), n.date, c.name, -SUM(l.net), -SUM(l.vat), n.entry_id
    FROM credit_note_lines l JOIN credit_notes n ON n.id = l.note_id JOIN sales_invoice_lines o ON o.id = l.invoice_line_id
    JOIN sales_invoices s ON s.id = o.invoice_id JOIN customers c ON c.id = s.customer_id
    JOIN items i ON i.id = o.item_id JOIN tax_codes t ON t.id = i.tax_code_id
   GROUP BY n.id, ${KIND("o.vat_rate")}
  UNION ALL
  SELECT 'purchases', ${KIND("l.vat_rate")}, 'purchase_invoice', p.reference, p.date, su.name, SUM(l.net), SUM(l.vat), p.entry_id
    FROM purchase_invoice_lines l JOIN purchase_invoices p ON p.id = l.invoice_id JOIN suppliers su ON su.id = p.supplier_id
    JOIN items i ON i.id = l.item_id JOIN tax_codes t ON t.id = i.tax_code_id
   WHERE p.currency = 'EGP'
   GROUP BY p.id, ${KIND("l.vat_rate")}
  UNION ALL
  SELECT 'purchases', ${KIND("o.vat_rate")}, 'debit_note', CAST(d.number AS TEXT), d.date, su.name, -SUM(l.net), -SUM(l.vat), d.entry_id
    FROM debit_note_lines l JOIN debit_notes d ON d.id = l.note_id JOIN purchase_invoice_lines o ON o.id = l.purchase_line_id
    JOIN purchase_invoices p ON p.id = o.invoice_id JOIN suppliers su ON su.id = p.supplier_id
    JOIN items i ON i.id = o.item_id JOIN tax_codes t ON t.id = i.tax_code_id
   WHERE p.currency = 'EGP'
   GROUP BY d.id, ${KIND("o.vat_rate")}
  UNION ALL
  SELECT 'expenses', 'standard', 'expense', CAST(x.number AS TEXT), x.date, COALESCE(su.name, ''), x.amount, x.vat, x.entry_id
    FROM expenses x LEFT JOIN suppliers su ON su.id = x.supplier_id
   WHERE x.vat > 0
  UNION ALL
  SELECT 'expenses', 'standard', 'expense_void', CAST(x.number AS TEXT), v.date, COALESCE(su.name, ''), -x.amount, -x.vat, v.id
    FROM expenses x JOIN journal_entries e ON e.id = x.entry_id JOIN journal_entries v ON v.id = e.voided_by
    LEFT JOIN suppliers su ON su.id = x.supplier_id
   WHERE x.vat > 0
  UNION ALL
  SELECT 'imports', 'standard', 'import_shipment', CAST(h.number AS TEXT), h.date, h.reference, SUM(c.amount), SUM(c.vat), h.entry_id
    FROM import_shipment_costs c JOIN import_shipments h ON h.id = c.shipment_id
   GROUP BY h.id HAVING SUM(c.vat) > 0`;

const BOX_ORDER: [VatSection, TaxKind][] = [
  ["sales", "standard"],
  ["sales", "zero_rated"],
  ["sales", "exempt"],
  ["purchases", "standard"],
  ["purchases", "zero_rated"],
  ["purchases", "exempt"],
  ["expenses", "standard"],
  ["imports", "standard"],
];

/** How much an account role moved in the period: credits less debits for output VAT, debits less credits for input. */
function movement(db: Database.Database, role: "output_vat" | "input_vat", from: IsoDate, to: IsoDate): Piastres {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(l.debit) - SUM(l.credit), 0) AS m FROM ledger_lines l JOIN journal_entries e ON e.id = l.entry_id
         JOIN accounts a ON a.id = l.account_id WHERE a.role = ? AND e.date BETWEEN ? AND ?`,
    )
    .get(role, from, to) as { m: number };
  return role === "output_vat" ? -row.m : row.m;
}

/** The VAT return for a period: output and input VAT by tax kind, the net due, and every document behind them. */
export function vatReturn(db: Database.Database, from: IsoDate, to: IsoDate): VatReturn {
  assertIsoDate(from);
  assertIsoDate(to);
  if (from > to) throw new BusinessError("date_range_invalid", `${from} is after ${to}`);
  if (!vatRegistered(db)) throw new BusinessError("not_vat_registered", "The business is not registered for VAT");
  const transactions = db
    .prepare(`SELECT * FROM (${TRANSACTIONS}) WHERE date BETWEEN ? AND ? ORDER BY section, taxKind, date, entryId`)
    .all(from, to) as VatTransaction[];
  const boxes = BOX_ORDER.map(([section, taxKind]) => {
    const rows = transactions.filter((t) => t.section === section && t.taxKind === taxKind);
    return { section, taxKind, net: rows.reduce((t, r) => t + r.net, 0), vat: rows.reduce((t, r) => t + r.vat, 0), count: rows.length };
  })
    .filter((b) => b.count > 0)
    .map(({ section, taxKind, net, vat }) => ({ section, taxKind, net, vat }));
  const outputVat = boxes.filter((b) => b.section === "sales").reduce((t, b) => t + b.vat, 0);
  const inputVat = boxes.filter((b) => b.section !== "sales").reduce((t, b) => t + b.vat, 0);
  const outputAdjustments = movement(db, "output_vat", from, to) - outputVat;
  const inputAdjustments = movement(db, "input_vat", from, to) - inputVat;
  return {
    from,
    to,
    boxes,
    outputVat,
    inputVat,
    outputAdjustments,
    inputAdjustments,
    netDue: outputVat + outputAdjustments - (inputVat + inputAdjustments),
    transactions,
  };
}
