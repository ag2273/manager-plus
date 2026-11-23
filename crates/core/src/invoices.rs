//! Tax invoices on customers' accounts, and credit notes against them.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::customers::{check_credit_limit, find_customer};
use crate::dates::assert_iso_date;
use crate::error::{refuse, Result};
use crate::items::{vat_rate, BasisPoints, Quantity};
use crate::ledger::{post_journal_entry, JournalEntryInput, JournalLine, Piastres};
use crate::num::{mul_div_round, safe_int};
use crate::purchases::vat_registered;
use crate::quotations::convert_quotation;
use crate::serials::{
    issue_serials, return_serials, serials_for, serials_on_line, warranty_end, Move,
};
use crate::shares::{next_number, share_of, take, Taken};
use crate::stock::{
    account_by_role, active_warehouse, assert_quantity, cost_of_issue, held_in, insert_movement,
    to_base_quantity, NewMovement, UnitLine,
};
use crate::users::{find_user, Credentials};

const ONE_UNIT: i64 = 1000;
const WHOLE: i64 = 10_000;

/** An invoice line: price per one of the chosen unit and a discount in piastres, both VAT-exclusive. */
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceLineInput {
    pub item_id: i64,
    /** "base" or "pack". */
    pub unit: String,
    pub quantity: f64,
    pub unit_price: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discount: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serials: Option<Vec<String>>,
}

impl InvoiceLineInput {
    pub fn base(item_id: i64, quantity: Quantity, unit_price: Piastres) -> Self {
        InvoiceLineInput {
            item_id,
            unit: "base".into(),
            quantity: quantity as f64,
            unit_price: unit_price as f64,
            ..Default::default()
        }
    }
    pub fn pack(item_id: i64, quantity: Quantity, unit_price: Piastres) -> Self {
        InvoiceLineInput {
            unit: "pack".into(),
            ..Self::base(item_id, quantity, unit_price)
        }
    }
    pub fn with_discount(mut self, discount: Piastres) -> Self {
        self.discount = Some(discount as f64);
        self
    }
    pub fn with_serials(mut self, serials: &[&str]) -> Self {
        self.serials = Some(serials.iter().map(|s| s.to_string()).collect());
        self
    }
    pub(crate) fn unit_line(&self) -> UnitLine {
        UnitLine {
            item_id: self.item_id,
            unit: self.unit.clone(),
            quantity: self.quantity,
            serials: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceLine {
    pub item_id: i64,
    pub unit: String,
    pub quantity: Quantity,
    pub unit_price: Piastres,
    /** Quantity × unit price. */
    pub gross: Piastres,
    pub discount: Piastres,
    pub net: Piastres,
    pub vat_rate: BasisPoints,
    pub vat: Piastres,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PricedInvoice {
    pub lines: Vec<InvoiceLine>,
    pub gross: Piastres,
    pub discount: Piastres,
    pub net: Piastres,
    pub vat: Piastres,
    pub total: Piastres,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SalesInvoiceInput {
    pub date: String,
    pub customer_id: i64,
    pub warehouse_id: i64,
    /** The customer's order number or similar. */
    pub reference: String,
    pub notes: String,
    pub lines: Vec<InvoiceLineInput>,
    /** The quotation this invoice comes from; it is marked converted. */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quotation_id: Option<i64>,
    /** A manager's sign-in when the invoice takes the customer past their credit limit. */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credit_approval: Option<Credentials>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SalesInvoiceResult {
    pub id: i64,
    pub number: i64,
    pub total: Piastres,
    pub below_zero: Vec<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CreditNoteRef {
    pub number: i64,
    pub date: String,
    pub total: Piastres,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SalesInvoiceLine {
    pub line_id: i64,
    pub item_id: i64,
    pub name_ar: String,
    pub name_en: String,
    pub unit: String,
    pub unit_name: String,
    pub quantity: Quantity,
    pub unit_price: Piastres,
    pub gross: Piastres,
    pub discount: Piastres,
    pub net: Piastres,
    pub vat_rate: BasisPoints,
    pub vat: Piastres,
    pub credited: Quantity,
    pub serials: Vec<String>,
    pub warranty_ends: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SalesInvoice {
    pub id: i64,
    pub number: i64,
    pub date: String,
    pub customer_id: i64,
    pub customer_name: String,
    pub warehouse_id: i64,
    pub reference: String,
    pub notes: String,
    pub posted_by: String,
    pub gross: Piastres,
    pub discount: Piastres,
    pub net: Piastres,
    pub vat: Piastres,
    pub total: Piastres,
    /** The total of credit notes against the invoice. */
    pub credited: Piastres,
    pub credit_notes: Vec<CreditNoteRef>,
    pub lines: Vec<SalesInvoiceLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditLineInput {
    pub line_id: i64,
    /** How much comes back, in thousandths of the line's unit. */
    pub quantity: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serials: Option<Vec<String>>,
}

impl CreditLineInput {
    pub fn new(line_id: i64, quantity: Quantity) -> Self {
        CreditLineInput {
            line_id,
            quantity: quantity as f64,
            serials: None,
        }
    }
    pub fn with_serials(mut self, serials: &[&str]) -> Self {
        self.serials = Some(serials.iter().map(|s| s.to_string()).collect());
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditNoteInput {
    pub date: String,
    pub invoice_id: i64,
    pub reason: String,
    pub lines: Vec<CreditLineInput>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PostedCreditNote {
    pub id: i64,
    pub number: i64,
    pub total: Piastres,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditNoteLine {
    pub item_id: i64,
    pub name_ar: String,
    pub name_en: String,
    pub unit: String,
    pub unit_name: String,
    pub quantity: Quantity,
    pub unit_price: Piastres,
    pub net: Piastres,
    pub vat: Piastres,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditNote {
    pub id: i64,
    pub number: i64,
    pub date: String,
    pub invoice_number: i64,
    pub customer_id: i64,
    pub customer_name: String,
    pub reason: String,
    pub posted_by: String,
    pub net: Piastres,
    pub vat: Piastres,
    pub total: Piastres,
    pub lines: Vec<CreditNoteLine>,
}

/** Prices invoice lines without posting: net = quantity × price − discount, VAT on net, rounded half-up per line. */
pub fn price_invoice(
    conn: &Connection,
    date: &str,
    lines: &[InvoiceLineInput],
) -> Result<PricedInvoice> {
    assert_iso_date(date)?;
    let registered = vat_registered(conn)?;
    let mut priced = Vec::with_capacity(lines.len());
    for line in lines {
        let quantity = assert_quantity(line.quantity)?;
        to_base_quantity(conn, &line.unit_line())?;
        let unit_price = match safe_int(line.unit_price) {
            Some(p) if p >= 0 => p,
            _ => {
                return refuse(
                    "price_invalid",
                    format!("Unit price {} is not whole piastres", line.unit_price),
                )
            }
        };
        let gross = mul_div_round(quantity, unit_price, ONE_UNIT);
        let given = line.discount.unwrap_or(0.0);
        let discount = match safe_int(given) {
            Some(d) if d >= 0 && d <= gross => d,
            _ => {
                return refuse(
                    "discount_invalid",
                    format!("Discount {given} does not fit a line of {gross}"),
                )
            }
        };
        let net = gross - discount;
        let tax_code: i64 = conn.query_row(
            "SELECT tax_code_id FROM items WHERE id = ?",
            [line.item_id],
            |r| r.get(0),
        )?;
        let rate = vat_rate(conn, tax_code, date, registered)?;
        priced.push(InvoiceLine {
            item_id: line.item_id,
            unit: line.unit.clone(),
            quantity,
            unit_price,
            gross,
            discount,
            net,
            vat_rate: rate,
            vat: mul_div_round(net, rate, WHOLE),
        });
    }
    let net: i64 = priced.iter().map(|l| l.net).sum();
    let vat: i64 = priced.iter().map(|l| l.vat).sum();
    Ok(PricedInvoice {
        gross: priced.iter().map(|l| l.gross).sum(),
        discount: priced.iter().map(|l| l.discount).sum(),
        net,
        vat,
        total: net + vat,
        lines: priced,
    })
}

/**
 * A tax invoice on the customer's account: Dr Receivables (tagged with the customer),
 * Cr Sales and Output VAT; Dr Cost of goods sold, Cr Stock at average cost.
 */
pub fn post_sales_invoice(
    conn: &Connection,
    input: &SalesInvoiceInput,
    user_id: i64,
) -> Result<SalesInvoiceResult> {
    let customer = find_customer(conn, input.customer_id)?;
    if !customer.active {
        return refuse(
            "customer_inactive",
            format!("Customer {} is stopped", customer.name),
        );
    }
    active_warehouse(conn, input.warehouse_id)?;
    if input.lines.is_empty() {
        return refuse("invoice_needs_lines", "An invoice needs at least one line");
    }
    let priced = price_invoice(conn, &input.date, &input.lines)?;
    if priced.total == 0 {
        return refuse("invoice_total_zero", "The invoice total is zero");
    }
    check_credit_limit(
        conn,
        &customer,
        priced.total,
        input.credit_approval.as_ref(),
        "postSalesInvoice",
        &find_user(conn, user_id)?.name,
    )?;

    let mut taken: Vec<(i64, Quantity, Piastres)> = Vec::new();
    let mut outs = Vec::with_capacity(priced.lines.len());
    for (line, given) in priced.lines.iter().zip(&input.lines) {
        let base = to_base_quantity(conn, &given.unit_line())?;
        let serials = serials_for(conn, line.item_id, base, given.serials.as_deref())?;
        let at = taken.iter().position(|t| t.0 == line.item_id);
        let before = at.map_or((0, 0), |i| (taken[i].1, taken[i].2));
        let cost = cost_of_issue(conn, line.item_id, base, before)?;
        match at {
            Some(i) => {
                taken[i].1 += base;
                taken[i].2 += cost;
            }
            None => taken.push((line.item_id, base, cost)),
        }
        outs.push((base, cost, serials));
    }
    let total_cost: Piastres = outs.iter().map(|o| o.1).sum();

    let number = next_number(conn, "sales_invoices")?;
    let mut journal = vec![JournalLine {
        customer_id: Some(customer.id),
        ..JournalLine::debit(account_by_role(conn, "receivables")?, priced.total)
    }];
    if priced.net > 0 {
        journal.push(JournalLine::credit(
            account_by_role(conn, "sales")?,
            priced.net,
        ));
    }
    if priced.vat > 0 {
        journal.push(JournalLine::credit(
            account_by_role(conn, "output_vat")?,
            priced.vat,
        ));
    }
    if total_cost > 0 {
        journal.push(JournalLine::debit(
            account_by_role(conn, "cost_of_goods_sold")?,
            total_cost,
        ));
        journal.push(JournalLine::credit(
            account_by_role(conn, "stock")?,
            total_cost,
        ));
    }
    let entry_id = post_journal_entry(
        conn,
        &JournalEntryInput {
            date: input.date.clone(),
            memo: format!("فاتورة مبيعات رقم {number} - {}", customer.name),
            lines: journal,
        },
        "sales_invoice",
    )?;
    conn.execute(
        "INSERT INTO sales_invoices (number, date, customer_id, warehouse_id, reference, notes, entry_id, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            number,
            input.date,
            customer.id,
            input.warehouse_id,
            input.reference.trim(),
            input.notes.trim(),
            entry_id,
            user_id
        ],
    )?;
    let id = conn.last_insert_rowid();
    if let Some(quotation) = input.quotation_id {
        convert_quotation(conn, quotation, customer.id, id)?;
    }
    for (l, (base, cost, serials)) in priced.lines.iter().zip(&outs) {
        conn.execute(
            "INSERT INTO sales_invoice_lines (invoice_id, item_id, unit, quantity, unit_price, discount, net, vat_rate, vat, cost)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![id, l.item_id, l.unit, l.quantity, l.unit_price, l.discount, l.net, l.vat_rate, l.vat, cost],
        )?;
        let line_id = conn.last_insert_rowid();
        issue_serials(
            conn,
            l.item_id,
            serials,
            &Move {
                date: &input.date,
                warehouse_id: input.warehouse_id,
                source: "sales_invoice",
                source_id: id,
                line_id: Some(line_id),
            },
        )?;
        insert_movement(
            conn,
            NewMovement {
                date: &input.date,
                item_id: l.item_id,
                warehouse_id: input.warehouse_id,
                quantity: -base,
                value: -cost,
                source: "sales_invoice",
                source_id: id,
            },
        )?;
    }
    let mut below_zero = Vec::new();
    for (item_id, _, _) in &taken {
        if held_in(conn, *item_id, input.warehouse_id)? < 0 {
            below_zero.push(*item_id);
        }
    }
    Ok(SalesInvoiceResult {
        id,
        number,
        total: priced.total,
        below_zero,
    })
}

const SELECT_INVOICES: &str = "
  SELECT s.id, s.number, s.date, s.customer_id, c.name, s.warehouse_id, s.reference, s.notes, u.name
    FROM sales_invoices s JOIN customers c ON c.id = s.customer_id JOIN users u ON u.id = s.user_id";

fn invoice_row(r: &rusqlite::Row) -> rusqlite::Result<SalesInvoice> {
    Ok(SalesInvoice {
        id: r.get(0)?,
        number: r.get(1)?,
        date: r.get(2)?,
        customer_id: r.get(3)?,
        customer_name: r.get(4)?,
        warehouse_id: r.get(5)?,
        reference: r.get(6)?,
        notes: r.get(7)?,
        posted_by: r.get(8)?,
        gross: 0,
        discount: 0,
        net: 0,
        vat: 0,
        total: 0,
        credited: 0,
        credit_notes: Vec::new(),
        lines: Vec::new(),
    })
}

fn with_lines(conn: &Connection, mut inv: SalesInvoice) -> Result<SalesInvoice> {
    let rows = conn
        .prepare_cached(
            "SELECT l.id, l.item_id, i.name_ar, i.name_en, l.unit, u.name, l.quantity, l.unit_price,
                    l.net + l.discount, l.discount, l.net, l.vat_rate, l.vat,
                    COALESCE((SELECT SUM(x.quantity) FROM credit_note_lines x WHERE x.invoice_line_id = l.id), 0)
               FROM sales_invoice_lines l JOIN items i ON i.id = l.item_id JOIN item_units u ON u.item_id = l.item_id AND u.kind = l.unit
              WHERE l.invoice_id = ? ORDER BY l.id",
        )?
        .query_map([inv.id], |x| {
            Ok(SalesInvoiceLine {
                line_id: x.get(0)?,
                item_id: x.get(1)?,
                name_ar: x.get(2)?,
                name_en: x.get(3)?,
                unit: x.get(4)?,
                unit_name: x.get(5)?,
                quantity: x.get(6)?,
                unit_price: x.get(7)?,
                gross: x.get(8)?,
                discount: x.get(9)?,
                net: x.get(10)?,
                vat_rate: x.get(11)?,
                vat: x.get(12)?,
                credited: x.get(13)?,
                serials: Vec::new(),
                warranty_ends: None,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for mut l in rows {
        l.serials = serials_on_line(conn, "sales_invoice", inv.id, l.line_id)?;
        if !l.serials.is_empty() {
            l.warranty_ends = warranty_end(conn, l.item_id, &inv.date)?;
        }
        inv.lines.push(l);
    }
    inv.credit_notes = conn
        .prepare_cached(
            "SELECT n.number, n.date, (SELECT SUM(x.net + x.vat) FROM credit_note_lines x WHERE x.note_id = n.id)
               FROM credit_notes n WHERE n.invoice_id = ? ORDER BY n.number",
        )?
        .query_map([inv.id], |x| {
            Ok(CreditNoteRef {
                number: x.get(0)?,
                date: x.get(1)?,
                total: x.get::<_, Option<i64>>(2)?.unwrap_or(0),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    inv.gross = inv.lines.iter().map(|l| l.gross).sum();
    inv.discount = inv.lines.iter().map(|l| l.discount).sum();
    inv.net = inv.lines.iter().map(|l| l.net).sum();
    inv.vat = inv.lines.iter().map(|l| l.vat).sum();
    inv.total = inv.net + inv.vat;
    inv.credited = inv.credit_notes.iter().map(|n| n.total).sum();
    Ok(inv)
}

/** Sales invoices, newest first. */
pub fn list_sales_invoices(conn: &Connection, limit: i64) -> Result<Vec<SalesInvoice>> {
    let rows = conn
        .prepare(&format!("{SELECT_INVOICES} ORDER BY s.number DESC LIMIT ?"))?
        .query_map([limit], invoice_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter().map(|r| with_lines(conn, r)).collect()
}

/** One invoice by its printed number. */
pub fn find_sales_invoice(conn: &Connection, number: i64) -> Result<SalesInvoice> {
    let row = conn
        .query_row(
            &format!("{SELECT_INVOICES} WHERE s.number = ?"),
            [number],
            invoice_row,
        )
        .optional()?;
    match row {
        Some(r) => with_lines(conn, r),
        None => refuse(
            "invoice_not_found",
            format!("No sales invoice number {number}"),
        ),
    }
}

struct Back {
    line_id: i64,
    item_id: i64,
    quantity: Quantity,
    base: Quantity,
    net: Piastres,
    vat: Piastres,
    cost: Piastres,
    serials: Vec<String>,
}

/**
 * Goods back from a customer against their invoice, at the invoice's price, VAT and
 * cost: Dr Sales, Dr Output VAT, Cr Receivables; Dr Stock, Cr Cost of goods sold;
 * stock back into the warehouse it left from.
 */
pub fn post_credit_note(
    conn: &Connection,
    input: &CreditNoteInput,
    user_id: i64,
) -> Result<PostedCreditNote> {
    assert_iso_date(&input.date)?;
    let invoice: Option<(i64, i64, i64, i64)> = conn
        .query_row(
            "SELECT id, number, customer_id, warehouse_id FROM sales_invoices WHERE id = ?",
            [input.invoice_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((invoice_id, invoice_number, customer_id, warehouse_id)) = invoice else {
        return refuse(
            "invoice_not_found",
            format!("No sales invoice with id {}", input.invoice_id),
        );
    };
    if input.lines.is_empty() {
        return refuse(
            "invoice_needs_lines",
            "A credit note needs at least one line",
        );
    }
    let mut taken: Vec<(i64, Taken)> = Vec::new();
    let mut backs = Vec::with_capacity(input.lines.len());
    for given in &input.lines {
        let quantity = assert_quantity(given.quantity)?;
        let line: Option<(i64, i64, i64, i64, i64, i64)> = conn
            .query_row(
                "SELECT l.item_id, l.quantity, l.net, l.vat, l.cost, COALESCE(u.size, 1000)
                   FROM sales_invoice_lines l LEFT JOIN item_units u ON u.item_id = l.item_id AND u.kind = l.unit
                  WHERE l.id = ? AND l.invoice_id = ?",
                params![given.line_id, invoice_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .optional()?;
        let Some((item_id, sold, net, vat, cost, size)) = line else {
            return refuse(
                "return_line_invalid",
                format!("Line {} is not on invoice {invoice_number}", given.line_id),
            );
        };
        let before = match taken.iter().find(|t| t.0 == given.line_id) {
            Some((_, t)) => t.clone(),
            None => conn.query_row(
                "SELECT COALESCE(SUM(quantity), 0), COALESCE(SUM(net), 0), COALESCE(SUM(vat), 0), COALESCE(SUM(cost), 0)
                   FROM credit_note_lines WHERE invoice_line_id = ?",
                [given.line_id],
                |r| {
                    Ok(Taken {
                        quantity: r.get(0)?,
                        values: vec![r.get(1)?, r.get(2)?, r.get(3)?],
                    })
                },
            )?,
        };
        if before.quantity + quantity > sold {
            return refuse(
                "return_exceeds_sale",
                format!(
                    "Only {} of line {} can still be credited",
                    sold - before.quantity,
                    given.line_id
                ),
            );
        }
        let share = share_of(&[net, vat, cost], sold, &before, quantity);
        let after = take(&before, quantity, &share);
        match taken.iter_mut().find(|t| t.0 == given.line_id) {
            Some(t) => t.1 = after,
            None => taken.push((given.line_id, after)),
        }
        let base = mul_div_round(quantity, size, ONE_UNIT);
        backs.push(Back {
            line_id: given.line_id,
            item_id,
            quantity,
            base,
            net: share[0],
            vat: share[1],
            cost: share[2],
            serials: serials_for(conn, item_id, base, given.serials.as_deref())?,
        });
    }
    let net: Piastres = backs.iter().map(|b| b.net).sum();
    let vat: Piastres = backs.iter().map(|b| b.vat).sum();
    let cost: Piastres = backs.iter().map(|b| b.cost).sum();
    let total = net + vat;
    let number = next_number(conn, "credit_notes")?;

    let mut journal = Vec::new();
    if net > 0 {
        journal.push(JournalLine::debit(account_by_role(conn, "sales")?, net));
    }
    if vat > 0 {
        journal.push(JournalLine::debit(
            account_by_role(conn, "output_vat")?,
            vat,
        ));
    }
    if total > 0 {
        journal.push(JournalLine {
            customer_id: Some(customer_id),
            ..JournalLine::credit(account_by_role(conn, "receivables")?, total)
        });
    }
    if cost > 0 {
        journal.push(JournalLine::debit(account_by_role(conn, "stock")?, cost));
        journal.push(JournalLine::credit(
            account_by_role(conn, "cost_of_goods_sold")?,
            cost,
        ));
    }
    let entry_id = post_journal_entry(
        conn,
        &JournalEntryInput {
            date: input.date.clone(),
            memo: format!("إشعار دائن رقم {number} على فاتورة {invoice_number}"),
            lines: journal,
        },
        "credit_note",
    )?;
    conn.execute(
        "INSERT INTO credit_notes (number, date, invoice_id, reason, entry_id, user_id) VALUES (?, ?, ?, ?, ?, ?)",
        params![number, input.date, invoice_id, input.reason.trim(), entry_id, user_id],
    )?;
    let id = conn.last_insert_rowid();
    for b in &backs {
        conn.execute(
            "INSERT INTO credit_note_lines (note_id, invoice_line_id, quantity, net, vat, cost) VALUES (?, ?, ?, ?, ?, ?)",
            params![id, b.line_id, b.quantity, b.net, b.vat, b.cost],
        )?;
        let line_id = conn.last_insert_rowid();
        return_serials(
            conn,
            b.item_id,
            &b.serials,
            ("sales_invoice", invoice_id),
            &Move {
                date: &input.date,
                warehouse_id,
                source: "credit_note",
                source_id: id,
                line_id: Some(line_id),
            },
        )?;
        insert_movement(
            conn,
            NewMovement {
                date: &input.date,
                item_id: b.item_id,
                warehouse_id,
                quantity: b.base,
                value: b.cost,
                source: "credit_note",
                source_id: id,
            },
        )?;
    }
    Ok(PostedCreditNote { id, number, total })
}

/** One credit note by its printed number. */
pub fn find_credit_note(conn: &Connection, number: i64) -> Result<CreditNote> {
    let row = conn
        .query_row(
            "SELECT n.id, n.number, n.date, s.number, s.customer_id, c.name, n.reason, u.name
               FROM credit_notes n JOIN sales_invoices s ON s.id = n.invoice_id
               JOIN customers c ON c.id = s.customer_id JOIN users u ON u.id = n.user_id
              WHERE n.number = ?",
            [number],
            |r| {
                Ok(CreditNote {
                    id: r.get(0)?,
                    number: r.get(1)?,
                    date: r.get(2)?,
                    invoice_number: r.get(3)?,
                    customer_id: r.get(4)?,
                    customer_name: r.get(5)?,
                    reason: r.get(6)?,
                    posted_by: r.get(7)?,
                    net: 0,
                    vat: 0,
                    total: 0,
                    lines: Vec::new(),
                })
            },
        )
        .optional()?;
    let Some(mut note) = row else {
        return refuse(
            "invoice_not_found",
            format!("No credit note number {number}"),
        );
    };
    note.lines = conn
        .prepare(
            "SELECT l.item_id, i.name_ar, i.name_en, l.unit, u.name, x.quantity, l.unit_price, x.net, x.vat
               FROM credit_note_lines x JOIN sales_invoice_lines l ON l.id = x.invoice_line_id JOIN items i ON i.id = l.item_id
               JOIN item_units u ON u.item_id = l.item_id AND u.kind = l.unit
              WHERE x.note_id = ? ORDER BY x.id",
        )?
        .query_map([note.id], |r| {
            Ok(CreditNoteLine {
                item_id: r.get(0)?,
                name_ar: r.get(1)?,
                name_en: r.get(2)?,
                unit: r.get(3)?,
                unit_name: r.get(4)?,
                quantity: r.get(5)?,
                unit_price: r.get(6)?,
                net: r.get(7)?,
                vat: r.get(8)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    note.net = note.lines.iter().map(|l| l.net).sum();
    note.vat = note.lines.iter().map(|l| l.vat).sum();
    note.total = note.net + note.vat;
    Ok(note)
}

/** A till receipt to be replaced by a tax invoice to a customer. */
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptInvoiceInput {
    pub date: String,
    pub receipt_id: i64,
    pub customer_id: i64,
    /** The customer's order number or similar. */
    #[serde(default)]
    pub reference: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptInvoiced {
    pub return_id: i64,
    pub return_number: i64,
    pub invoice_id: i64,
    pub invoice_number: i64,
    pub total: Piastres,
}

/** One receipt line as an invoice line with the same VAT-exclusive amount: the price rounded up, the rest as discount. */
fn as_invoice_line(
    item_id: i64,
    unit: String,
    quantity: Quantity,
    net: Piastres,
) -> InvoiceLineInput {
    let unit_price = (net * ONE_UNIT + quantity - 1) / quantity;
    let gross = mul_div_round(quantity, unit_price, ONE_UNIT);
    InvoiceLineInput {
        item_id,
        unit,
        quantity: quantity as f64,
        unit_price: unit_price as f64,
        discount: (gross > net).then_some((gross - net) as f64),
        serials: None,
    }
}

/**
 * Turns a till receipt into a tax invoice to a company customer (#97, note 7): the whole
 * receipt comes back to that customer's account, as a return at the till, and an invoice
 * for the same goods at the same VAT-exclusive amounts is raised in its place, settled by
 * the return's credit. The sale is counted once, and with the ETA the e-receipt is
 * cancelled by the return's e-receipt while the invoice goes as an e-invoice.
 */
pub fn invoice_receipt(
    conn: &Connection,
    input: &ReceiptInvoiceInput,
    user_id: i64,
) -> Result<ReceiptInvoiced> {
    let receipt: Option<(i64, i64, Option<i64>)> = conn
        .query_row(
            "SELECT number, warehouse_id, customer_id FROM sales_receipts WHERE id = ?",
            [input.receipt_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((number, warehouse_id, sold_to)) = receipt else {
        return refuse(
            "receipt_not_found",
            format!("No receipt with id {}", input.receipt_id),
        );
    };
    let invoiced: Option<i64> = conn
        .query_row(
            "SELECT s.number FROM receipt_invoices x JOIN sales_invoices s ON s.id = x.invoice_id WHERE x.receipt_id = ?",
            [input.receipt_id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(invoice) = invoiced {
        return Err(crate::error::BusinessError::new(
            "receipt_invoiced",
            format!("Receipt {number} is already invoice {invoice}"),
        )
        .with_detail(invoice.to_string()));
    }
    let returned: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sales_returns WHERE receipt_id = ?",
        [input.receipt_id],
        |r| r.get(0),
    )?;
    if returned > 0 {
        return refuse(
            "receipt_has_returns",
            format!("Receipt {number} already has goods returned on it"),
        );
    }
    if sold_to.is_some_and(|c| c != input.customer_id) {
        return refuse(
            "receipt_customer_differs",
            format!("Receipt {number} was sold to another customer"),
        );
    }
    find_customer(conn, input.customer_id)?;

    struct Sold {
        line_id: i64,
        item_id: i64,
        unit: String,
        quantity: Quantity,
        net: Piastres,
        serials: Vec<String>,
    }
    let mut sold: Vec<Sold> = conn
        .prepare(
            "SELECT id, item_id, unit, quantity, net FROM sales_receipt_lines WHERE receipt_id = ? ORDER BY id",
        )?
        .query_map([input.receipt_id], |r| {
            Ok(Sold {
                line_id: r.get(0)?,
                item_id: r.get(1)?,
                unit: r.get(2)?,
                quantity: r.get(3)?,
                net: r.get(4)?,
                serials: Vec::new(),
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    for l in &mut sold {
        l.serials = serials_on_line(conn, "sale", input.receipt_id, l.line_id)?;
    }
    let with_serials = |serials: &[String]| (!serials.is_empty()).then(|| serials.to_vec());

    let back = crate::returns::return_to(
        conn,
        &crate::returns::ReturnInput {
            date: input.date.clone(),
            receipt_id: input.receipt_id,
            lines: sold
                .iter()
                .map(|l| crate::returns::ReturnLineInput {
                    line_id: l.line_id,
                    quantity: l.quantity as f64,
                    serials: with_serials(&l.serials),
                })
                .collect(),
            refund: "account".into(),
        },
        user_id,
        Some(input.customer_id),
    )?;
    let invoice = post_sales_invoice(
        conn,
        &SalesInvoiceInput {
            date: input.date.clone(),
            customer_id: input.customer_id,
            warehouse_id,
            reference: input.reference.trim().to_string(),
            notes: format!("بدلًا من إيصال البيع رقم {number}"),
            lines: sold
                .iter()
                .map(|l| InvoiceLineInput {
                    serials: with_serials(&l.serials),
                    ..as_invoice_line(l.item_id, l.unit.clone(), l.quantity, l.net)
                })
                .collect(),
            quotation_id: None,
            credit_approval: None,
        },
        user_id,
    )?;
    conn.execute(
        "INSERT INTO receipt_invoices (receipt_id, return_id, invoice_id) VALUES (?, ?, ?)",
        params![input.receipt_id, back.id, invoice.id],
    )?;
    Ok(ReceiptInvoiced {
        return_id: back.id,
        return_number: back.number,
        invoice_id: invoice.id,
        invoice_number: invoice.number,
        total: invoice.total,
    })
}
