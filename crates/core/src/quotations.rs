//! Quotations: priced like invoices, posting nothing, until one becomes an invoice.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::customers::find_customer;
use crate::dates::assert_iso_date;
use crate::error::{refuse, Result};
use crate::invoices::{price_invoice, InvoiceLine, InvoiceLineInput};
use crate::items::vat_rate;
use crate::ledger::Piastres;
use crate::num::mul_div_round;
use crate::purchases::vat_registered;
use crate::shares::next_number;

const WHOLE: i64 = 10_000;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotationInput {
    pub date: String,
    /** The last day the prices stand. */
    pub valid_until: String,
    pub customer_id: i64,
    /** The customer's request number or similar. */
    pub reference: String,
    pub notes: String,
    /** Serials, if sent, are ignored: a quotation moves no stock. */
    pub lines: Vec<InvoiceLineInput>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotationLine {
    #[serde(flatten)]
    pub line: InvoiceLine,
    pub name_ar: String,
    pub name_en: String,
    pub unit_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Quotation {
    pub id: i64,
    pub number: i64,
    pub date: String,
    pub valid_until: String,
    pub customer_id: i64,
    pub customer_name: String,
    pub reference: String,
    pub notes: String,
    pub prepared_by: String,
    /** "open", "expired" or "converted". */
    pub status: &'static str,
    /** The sales invoice it became, once converted. */
    pub invoice_number: Option<i64>,
    pub gross: Piastres,
    pub discount: Piastres,
    pub net: Piastres,
    pub vat: Piastres,
    pub total: Piastres,
    pub lines: Vec<QuotationLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SavedQuotation {
    pub id: i64,
    pub number: i64,
}

/**
 * The VAT-exclusive price of one unit for a customer: the wholesale price for wholesale
 * customers when the item has one, otherwise the retail price, with VAT taken off half-up.
 */
pub fn list_price(
    conn: &Connection,
    customer_id: Option<i64>,
    item_id: i64,
    unit: &str,
    date: &str,
) -> Result<Piastres> {
    let level = match customer_id {
        None => "retail".to_string(),
        Some(id) => find_customer(conn, id)?.price_level,
    };
    let row: Option<(i64, Option<i64>, i64)> = conn
        .query_row(
            "SELECT u.sale_price, u.wholesale_price, i.tax_code_id FROM item_units u JOIN items i ON i.id = u.item_id
              WHERE u.item_id = ? AND u.kind = ?",
            params![item_id, unit],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((retail, wholesale, tax_code_id)) = row else {
        return refuse(
            "item_not_found",
            format!("No {unit} unit for item {item_id}"),
        );
    };
    let inclusive = match wholesale {
        Some(w) if level == "wholesale" => w,
        _ => retail,
    };
    let rate = vat_rate(conn, tax_code_id, date, vat_registered(conn)?)?;
    Ok(mul_div_round(inclusive, WHOLE, WHOLE + rate))
}

/** Saves a quotation. It is priced like an invoice but posts nothing and moves no stock. */
pub fn save_quotation(
    conn: &Connection,
    input: &QuotationInput,
    user_id: i64,
) -> Result<SavedQuotation> {
    assert_iso_date(&input.date)?;
    assert_iso_date(&input.valid_until)?;
    if input.valid_until < input.date {
        return refuse(
            "date_range_invalid",
            format!("Valid until {} is before {}", input.valid_until, input.date),
        );
    }
    let customer = find_customer(conn, input.customer_id)?;
    if !customer.active {
        return refuse(
            "customer_inactive",
            format!("Customer {} is stopped", customer.name),
        );
    }
    if input.lines.is_empty() {
        return refuse("invoice_needs_lines", "A quotation needs at least one line");
    }
    let lines: Vec<InvoiceLineInput> = input
        .lines
        .iter()
        .map(|l| InvoiceLineInput {
            serials: None,
            ..l.clone()
        })
        .collect();
    let priced = price_invoice(conn, &input.date, &lines)?;
    let number = next_number(conn, "quotations")?;
    conn.execute(
        "INSERT INTO quotations (number, date, valid_until, customer_id, reference, notes, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        params![
            number,
            input.date,
            input.valid_until,
            customer.id,
            input.reference.trim(),
            input.notes.trim(),
            user_id
        ],
    )?;
    let id = conn.last_insert_rowid();
    for l in &priced.lines {
        conn.execute(
            "INSERT INTO quotation_lines (quotation_id, item_id, unit, quantity, unit_price, discount) VALUES (?, ?, ?, ?, ?, ?)",
            params![id, l.item_id, l.unit, l.quantity, l.unit_price, l.discount],
        )?;
    }
    Ok(SavedQuotation { id, number })
}

/** Marks a quotation as turned into an invoice; called inside the invoice's transaction. */
pub fn convert_quotation(
    conn: &Connection,
    quotation_id: i64,
    customer_id: i64,
    invoice_id: i64,
) -> Result<()> {
    let row: Option<(i64, Option<i64>)> = conn
        .query_row(
            "SELECT customer_id, invoice_id FROM quotations WHERE id = ?",
            [quotation_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((owner, invoice)) = row else {
        return refuse(
            "quotation_not_found",
            format!("No quotation with id {quotation_id}"),
        );
    };
    if invoice.is_some() {
        return refuse(
            "quotation_converted",
            format!("Quotation {quotation_id} is already an invoice"),
        );
    }
    if owner != customer_id {
        return refuse(
            "quotation_customer_mismatch",
            format!("Quotation {quotation_id} is for another customer"),
        );
    }
    conn.execute(
        "UPDATE quotations SET invoice_id = ? WHERE id = ?",
        params![invoice_id, quotation_id],
    )?;
    Ok(())
}

const SELECT: &str = "
  SELECT q.id, q.number, q.date, q.valid_until, q.customer_id, c.name, q.reference, q.notes, u.name, s.number
    FROM quotations q JOIN customers c ON c.id = q.customer_id JOIN users u ON u.id = q.user_id
    LEFT JOIN sales_invoices s ON s.id = q.invoice_id";

fn quotation_row(r: &rusqlite::Row) -> rusqlite::Result<Quotation> {
    Ok(Quotation {
        id: r.get(0)?,
        number: r.get(1)?,
        date: r.get(2)?,
        valid_until: r.get(3)?,
        customer_id: r.get(4)?,
        customer_name: r.get(5)?,
        reference: r.get(6)?,
        notes: r.get(7)?,
        prepared_by: r.get(8)?,
        invoice_number: r.get(9)?,
        status: "open",
        gross: 0,
        discount: 0,
        net: 0,
        vat: 0,
        total: 0,
        lines: Vec::new(),
    })
}

fn with_lines(conn: &Connection, mut q: Quotation, today: &str) -> Result<Quotation> {
    type Stored = (InvoiceLineInput, String, String, String);
    let stored: Vec<Stored> = conn
        .prepare_cached(
            "SELECT l.item_id, l.unit, l.quantity, l.unit_price, l.discount, i.name_ar, i.name_en, u.name
               FROM quotation_lines l JOIN items i ON i.id = l.item_id JOIN item_units u ON u.item_id = l.item_id AND u.kind = l.unit
              WHERE l.quotation_id = ? ORDER BY l.id",
        )?
        .query_map([q.id], |r| {
            Ok((
                InvoiceLineInput {
                    item_id: r.get(0)?,
                    unit: r.get(1)?,
                    quantity: r.get::<_, i64>(2)? as f64,
                    unit_price: r.get::<_, i64>(3)? as f64,
                    discount: Some(r.get::<_, i64>(4)? as f64),
                    serials: None,
                },
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let inputs: Vec<InvoiceLineInput> = stored.iter().map(|s| s.0.clone()).collect();
    let priced = price_invoice(conn, &q.date, &inputs)?;
    q.status = if q.invoice_number.is_some() {
        "converted"
    } else if q.valid_until.as_str() < today {
        "expired"
    } else {
        "open"
    };
    q.gross = priced.gross;
    q.discount = priced.discount;
    q.net = priced.net;
    q.vat = priced.vat;
    q.total = priced.total;
    q.lines = priced
        .lines
        .into_iter()
        .zip(stored)
        .map(|(line, (_, name_ar, name_en, unit_name))| QuotationLine {
            line,
            name_ar,
            name_en,
            unit_name,
        })
        .collect();
    Ok(q)
}

/** Quotations, newest first, with their status on `today`. */
pub fn list_quotations(conn: &Connection, today: &str) -> Result<Vec<Quotation>> {
    assert_iso_date(today)?;
    let rows = conn
        .prepare(&format!("{SELECT} ORDER BY q.number DESC"))?
        .query_map([], quotation_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|r| with_lines(conn, r, today))
        .collect()
}

pub fn find_quotation(conn: &Connection, number: i64, today: &str) -> Result<Quotation> {
    assert_iso_date(today)?;
    let row = conn
        .query_row(
            &format!("{SELECT} WHERE q.number = ?"),
            [number],
            quotation_row,
        )
        .optional()?;
    match row {
        Some(r) => with_lines(conn, r, today),
        None => refuse(
            "quotation_not_found",
            format!("No quotation number {number}"),
        ),
    }
}
