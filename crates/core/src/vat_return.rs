//! The VAT return: output and input VAT by tax kind, the net due, and every document behind them.

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::error::{refuse, Result};
use crate::ledger::Piastres;
use crate::purchases::vat_registered;
use crate::reports::range;

/** One document's lines under one tax kind: what each figure on the return drills down to. */
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VatTransaction {
    /** sales, purchases, expenses or imports. */
    pub section: String,
    /** standard, zero_rated or exempt. */
    pub tax_kind: String,
    /** sale, sale_return, sales_invoice, credit_note, purchase_invoice, debit_note, expense, expense_void, import_shipment */
    pub kind: String,
    /** The document's number; a purchase invoice shows the supplier's reference instead. */
    pub number: String,
    pub date: String,
    pub party: String,
    pub net: Piastres,
    pub vat: Piastres,
    pub entry_id: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VatBox {
    pub section: &'static str,
    pub tax_kind: &'static str,
    pub net: Piastres,
    pub vat: Piastres,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VatReturn {
    pub from: String,
    pub to: String,
    /** Sales and purchases per tax kind, then expenses and VAT paid at customs; empty boxes left out. */
    pub boxes: Vec<VatBox>,
    pub output_vat: Piastres,
    pub input_vat: Piastres,
    /**
     * What the VAT accounts moved by in the period beyond the documents above, such as journal
     * entries posted straight to them. Zero when everything went through documents.
     */
    pub output_adjustments: Piastres,
    pub input_adjustments: Piastres,
    /** Output less input, adjustments included; negative is VAT to carry forward. */
    pub net_due: Piastres,
    pub transactions: Vec<VatTransaction>,
}

/**
 * Each document's lines by tax kind: anything that carried VAT is standard-rated; a line at 0%
 * takes its item's kind, so zero-rated and exempt sales stay apart.
 */
const TRANSACTIONS: &str = "
  SELECT 'sales' AS section, CASE WHEN l.vat_rate > 0 THEN 'standard' ELSE t.kind END AS taxKind, 'sale' AS kind, CAST(r.number AS TEXT) AS number, r.date, '' AS party,
         SUM(l.net) AS net, SUM(l.vat) AS vat, r.entry_id AS entryId
    FROM sales_receipt_lines l JOIN sales_receipts r ON r.id = l.receipt_id JOIN items i ON i.id = l.item_id JOIN tax_codes t ON t.id = i.tax_code_id
   GROUP BY r.id, CASE WHEN l.vat_rate > 0 THEN 'standard' ELSE t.kind END
  UNION ALL
  SELECT 'sales', CASE WHEN o.vat_rate > 0 THEN 'standard' ELSE t.kind END, 'sale_return', CAST(x.number AS TEXT), x.date, '', -SUM(l.net), -SUM(l.vat), x.entry_id
    FROM sales_return_lines l JOIN sales_returns x ON x.id = l.return_id JOIN sales_receipt_lines o ON o.id = l.receipt_line_id
    JOIN items i ON i.id = o.item_id JOIN tax_codes t ON t.id = i.tax_code_id
   GROUP BY x.id, CASE WHEN o.vat_rate > 0 THEN 'standard' ELSE t.kind END
  UNION ALL
  SELECT 'sales', CASE WHEN l.vat_rate > 0 THEN 'standard' ELSE t.kind END, 'sales_invoice', CAST(s.number AS TEXT), s.date, c.name, SUM(l.net), SUM(l.vat), s.entry_id
    FROM sales_invoice_lines l JOIN sales_invoices s ON s.id = l.invoice_id JOIN customers c ON c.id = s.customer_id
    JOIN items i ON i.id = l.item_id JOIN tax_codes t ON t.id = i.tax_code_id
   GROUP BY s.id, CASE WHEN l.vat_rate > 0 THEN 'standard' ELSE t.kind END
  UNION ALL
  SELECT 'sales', CASE WHEN o.vat_rate > 0 THEN 'standard' ELSE t.kind END, 'credit_note', CAST(n.number AS TEXT), n.date, c.name, -SUM(l.net), -SUM(l.vat), n.entry_id
    FROM credit_note_lines l JOIN credit_notes n ON n.id = l.note_id JOIN sales_invoice_lines o ON o.id = l.invoice_line_id
    JOIN sales_invoices s ON s.id = o.invoice_id JOIN customers c ON c.id = s.customer_id
    JOIN items i ON i.id = o.item_id JOIN tax_codes t ON t.id = i.tax_code_id
   GROUP BY n.id, CASE WHEN o.vat_rate > 0 THEN 'standard' ELSE t.kind END
  UNION ALL
  SELECT 'purchases', CASE WHEN l.vat_rate > 0 THEN 'standard' ELSE t.kind END, 'purchase_invoice', p.reference, p.date, su.name, SUM(l.net), SUM(l.vat), p.entry_id
    FROM purchase_invoice_lines l JOIN purchase_invoices p ON p.id = l.invoice_id JOIN suppliers su ON su.id = p.supplier_id
    JOIN items i ON i.id = l.item_id JOIN tax_codes t ON t.id = i.tax_code_id
   WHERE p.currency = 'EGP'
   GROUP BY p.id, CASE WHEN l.vat_rate > 0 THEN 'standard' ELSE t.kind END
  UNION ALL
  SELECT 'purchases', CASE WHEN o.vat_rate > 0 THEN 'standard' ELSE t.kind END, 'debit_note', CAST(d.number AS TEXT), d.date, su.name, -SUM(l.net), -SUM(l.vat), d.entry_id
    FROM debit_note_lines l JOIN debit_notes d ON d.id = l.note_id JOIN purchase_invoice_lines o ON o.id = l.purchase_line_id
    JOIN purchase_invoices p ON p.id = o.invoice_id JOIN suppliers su ON su.id = p.supplier_id
    JOIN items i ON i.id = o.item_id JOIN tax_codes t ON t.id = i.tax_code_id
   WHERE p.currency = 'EGP'
   GROUP BY d.id, CASE WHEN o.vat_rate > 0 THEN 'standard' ELSE t.kind END
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
   GROUP BY h.id HAVING SUM(c.vat) > 0";

const BOX_ORDER: [(&str, &str); 8] = [
    ("sales", "standard"),
    ("sales", "zero_rated"),
    ("sales", "exempt"),
    ("purchases", "standard"),
    ("purchases", "zero_rated"),
    ("purchases", "exempt"),
    ("expenses", "standard"),
    ("imports", "standard"),
];

/** How much an account role moved in the period: credits less debits for output VAT, debits less credits for input. */
fn movement(conn: &Connection, role: &str, from: &str, to: &str) -> Result<Piastres> {
    let moved: i64 = conn.query_row(
        "SELECT COALESCE(SUM(l.debit) - SUM(l.credit), 0) FROM ledger_lines l JOIN journal_entries e ON e.id = l.entry_id
           JOIN accounts a ON a.id = l.account_id WHERE a.role = ? AND e.date BETWEEN ? AND ?",
        params![role, from, to],
        |r| r.get(0),
    )?;
    Ok(if role == "output_vat" { -moved } else { moved })
}

/** The VAT return for a period: output and input VAT by tax kind, the net due, and every document behind them. */
pub fn vat_return(conn: &Connection, from: &str, to: &str) -> Result<VatReturn> {
    range(from, to)?;
    if !vat_registered(conn)? {
        return refuse(
            "not_vat_registered",
            "The business is not registered for VAT",
        );
    }
    let transactions: Vec<VatTransaction> = conn
        .prepare(&format!(
            "SELECT * FROM ({TRANSACTIONS}) WHERE date BETWEEN ? AND ? ORDER BY section, taxKind, date, entryId"
        ))?
        .query_map(params![from, to], |r| {
            Ok(VatTransaction {
                section: r.get(0)?,
                tax_kind: r.get(1)?,
                kind: r.get(2)?,
                number: r.get(3)?,
                date: r.get(4)?,
                party: r.get(5)?,
                net: r.get(6)?,
                vat: r.get(7)?,
                entry_id: r.get(8)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let boxes: Vec<VatBox> = BOX_ORDER
        .iter()
        .filter_map(|&(section, tax_kind)| {
            let rows: Vec<&VatTransaction> = transactions
                .iter()
                .filter(|t| t.section == section && t.tax_kind == tax_kind)
                .collect();
            (!rows.is_empty()).then(|| VatBox {
                section,
                tax_kind,
                net: rows.iter().map(|r| r.net).sum(),
                vat: rows.iter().map(|r| r.vat).sum(),
            })
        })
        .collect();
    let output_vat: Piastres = boxes
        .iter()
        .filter(|b| b.section == "sales")
        .map(|b| b.vat)
        .sum();
    let input_vat: Piastres = boxes
        .iter()
        .filter(|b| b.section != "sales")
        .map(|b| b.vat)
        .sum();
    let output_adjustments = movement(conn, "output_vat", from, to)? - output_vat;
    let input_adjustments = movement(conn, "input_vat", from, to)? - input_vat;
    Ok(VatReturn {
        from: from.into(),
        to: to.into(),
        boxes,
        output_vat,
        input_vat,
        output_adjustments,
        input_adjustments,
        net_due: output_vat + output_adjustments - (input_vat + input_adjustments),
        transactions,
    })
}
