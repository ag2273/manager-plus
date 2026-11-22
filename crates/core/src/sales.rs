//! The till: pricing with discounts, tenders, receipts and held carts.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::customers::{check_credit_limit, find_customer};
use crate::dates::assert_iso_date;
use crate::error::{refuse, Result};
use crate::items::{vat_rate, BasisPoints, Quantity};
use crate::ledger::{post_journal_entry, JournalEntryInput, JournalLine, Piastres};
use crate::num::{mul_div_round, safe_int};
use crate::purchases::vat_registered;
use crate::serials::{issue_serials, serials_for, serials_on_line, warranty_end, Move};
use crate::shares::next_number;
use crate::shifts::require_open_shift;
use crate::stock::{
    account_by_role, active_warehouse, assert_quantity, cost_of_issue, held_in, insert_movement,
    to_base_quantity, NewMovement, UnitLine,
};
use crate::users::{find_user, now_iso, Credentials};

const WHOLE: i64 = 10_000;
const ONE_UNIT: i64 = 1000;

/** A discount in piastres off ("amount"), or a percentage in basis points ("percent", 1000 = 10%). */
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Discount {
    pub kind: String,
    pub value: f64,
}

impl Discount {
    pub fn amount(value: Piastres) -> Self {
        Discount {
            kind: "amount".into(),
            value: value as f64,
        }
    }
    pub fn percent(value: BasisPoints) -> Self {
        Discount {
            kind: "percent".into(),
            value: value as f64,
        }
    }
}

/** A till line: the item, which unit was rung up, how many (thousandths of that unit), and any discount. */
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleLineInput {
    pub item_id: i64,
    /** "base" or "pack". */
    pub unit: String,
    pub quantity: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serials: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discount: Option<Discount>,
}

impl SaleLineInput {
    pub fn base(item_id: i64, quantity: Quantity) -> Self {
        SaleLineInput {
            item_id,
            unit: "base".into(),
            quantity: quantity as f64,
            ..Default::default()
        }
    }
    pub fn pack(item_id: i64, quantity: Quantity) -> Self {
        SaleLineInput {
            unit: "pack".into(),
            ..Self::base(item_id, quantity)
        }
    }
    pub fn with_discount(mut self, discount: Discount) -> Self {
        self.discount = Some(discount);
        self
    }
    pub fn with_serials(mut self, serials: &[&str]) -> Self {
        self.serials = Some(serials.iter().map(|s| s.to_string()).collect());
        self
    }
    fn unit_line(&self) -> UnitLine {
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
pub struct SaleLine {
    pub item_id: i64,
    pub unit: String,
    pub quantity: Quantity,
    pub unit_price: Piastres,
    /** Quantity × shelf price, before discounts. */
    pub gross: Piastres,
    /** The line's own discount plus its share of the receipt discount. */
    pub discount: Piastres,
    /** What the customer pays for the line: gross − discount, VAT included. */
    pub amount: Piastres,
    pub net: Piastres,
    pub vat_rate: BasisPoints,
    pub vat: Piastres,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PricedSale {
    pub lines: Vec<SaleLine>,
    /** Shelf prices before any discount. */
    pub gross: Piastres,
    pub discount: Piastres,
    pub net: Piastres,
    pub vat: Piastres,
    pub total: Piastres,
}

pub const PAYMENT_METHODS: [&str; 3] = ["cash", "card", "wallet"];

/** A tender at the till. Cash is what the customer handed over, before change. */
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaymentInput {
    pub method: String,
    pub amount: f64,
}

impl PaymentInput {
    pub fn new(method: &str, amount: Piastres) -> Self {
        PaymentInput {
            method: method.into(),
            amount: amount as f64,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Payment {
    pub method: String,
    pub amount: Piastres,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleInput {
    pub date: String,
    pub warehouse_id: i64,
    pub lines: Vec<SaleLineInput>,
    pub payments: Vec<PaymentInput>,
    /** A discount on the whole receipt, spread over the lines. */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discount: Option<Discount>,
    /** Needed when part of the total is left on credit. */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub customer_id: Option<i64>,
    /** A manager's sign-in when the credit takes the customer past their limit. */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credit_approval: Option<Credentials>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CashSaleInput {
    pub date: String,
    pub warehouse_id: i64,
    pub lines: Vec<SaleLineInput>,
    pub cash_received: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleResult {
    pub id: i64,
    pub number: i64,
    pub total: Piastres,
    pub change: Piastres,
    /** Items whose quantity on hand went below zero with this sale. */
    pub below_zero: Vec<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EtaState {
    pub uuid: String,
    pub previous_uuid: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptLine {
    pub line_id: i64,
    pub item_id: i64,
    pub name_ar: String,
    pub name_en: String,
    pub unit: String,
    pub quantity: Quantity,
    pub unit_price: Piastres,
    pub gross: Piastres,
    pub discount: Piastres,
    pub amount: Piastres,
    pub net: Piastres,
    pub vat_rate: BasisPoints,
    pub vat: Piastres,
    pub cost: Piastres,
    pub returned: Quantity,
    pub serials: Vec<String>,
    pub warranty_ends: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub id: i64,
    pub number: i64,
    pub date: String,
    /** When the sale was made, as an ISO timestamp in UTC. */
    pub at: String,
    pub warehouse_id: i64,
    pub net: Piastres,
    pub vat: Piastres,
    pub total: Piastres,
    pub cash_received: Piastres,
    pub change: Piastres,
    /** What each tender paid; cash is after change. */
    pub payments: Vec<Payment>,
    /** The part of the total left on the customer's account. */
    pub on_credit: Piastres,
    pub customer_id: Option<i64>,
    pub sold_by: String,
    pub eta: EtaState,
    pub lines: Vec<ReceiptLine>,
}

/** The piastres a discount takes off `amount`; refuses a negative discount or one larger than the amount. */
fn discount_off(discount: Option<&Discount>, amount: Piastres) -> Result<Piastres> {
    let Some(Discount { kind, value }) = discount else {
        return Ok(0);
    };
    let whole = safe_int(*value).filter(|v| *v >= 0);
    let valid = whole.filter(|v| match kind.as_str() {
        "amount" => *v <= amount,
        "percent" => *v <= WHOLE,
        _ => false,
    });
    match valid {
        Some(v) if kind == "amount" => Ok(v),
        Some(v) => Ok(mul_div_round(amount, v, WHOLE)),
        None => refuse(
            "discount_invalid",
            format!("Discount {kind} {value} does not fit an amount of {amount}"),
        ),
    }
}

/** Splits `total` over `weights` in proportion, rounding down; the remainder goes to the largest weight. */
fn spread(total: Piastres, weights: &[Piastres]) -> Vec<Piastres> {
    let sum: i64 = weights.iter().sum();
    if total == 0 || sum == 0 {
        return vec![0; weights.len()];
    }
    let mut shares: Vec<i64> = weights
        .iter()
        .map(|&w| (total as i128 * w as i128).div_euclid(sum as i128) as i64)
        .collect();
    let max = *weights.iter().max().unwrap_or(&0);
    let largest = weights.iter().position(|&w| w == max).unwrap_or(0);
    shares[largest] += total - shares.iter().sum::<i64>();
    shares
}

/**
 * Prices till lines at the shelf price of the unit rung up, less line discounts and
 * a share of any receipt discount. Shelf prices include VAT, so per line:
 * net = round(amount / (1 + rate)), half-up, and VAT = amount − net.
 */
pub fn price_sale(
    conn: &Connection,
    date: &str,
    lines: &[SaleLineInput],
    receipt_discount: Option<&Discount>,
) -> Result<PricedSale> {
    assert_iso_date(date)?;
    let registered = vat_registered(conn)?;
    struct Shelf {
        quantity: Quantity,
        price: Piastres,
        tax_code_id: i64,
        gross: Piastres,
        own: Piastres,
        after_own: Piastres,
    }
    let mut shelf = Vec::with_capacity(lines.len());
    for line in lines {
        let quantity = assert_quantity(line.quantity)?;
        let unit: Option<(i64, i64)> = conn
            .query_row(
                "SELECT u.sale_price, i.tax_code_id FROM items i JOIN item_units u ON u.item_id = i.id AND u.kind = ?
                  WHERE i.id = ?",
                params![line.unit, line.item_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((price, tax_code_id)) = unit else {
            let exists = conn
                .query_row("SELECT 1 FROM items WHERE id = ?", [line.item_id], |_| {
                    Ok(())
                })
                .optional()?;
            if exists.is_none() {
                return refuse(
                    "item_not_found",
                    format!("No item with id {}", line.item_id),
                );
            }
            return refuse(
                "item_has_no_pack",
                format!("Item {} has no pack unit", line.item_id),
            );
        };
        let gross = mul_div_round(quantity, price, ONE_UNIT);
        let own = discount_off(line.discount.as_ref(), gross)?;
        shelf.push(Shelf {
            quantity,
            price,
            tax_code_id,
            gross,
            own,
            after_own: gross - own,
        });
    }
    let subtotal: i64 = shelf.iter().map(|l| l.after_own).sum();
    let weights: Vec<i64> = shelf.iter().map(|l| l.after_own).collect();
    let shares = spread(discount_off(receipt_discount, subtotal)?, &weights);
    let mut priced = Vec::with_capacity(lines.len());
    for ((line, s), share) in lines.iter().zip(&shelf).zip(&shares) {
        let amount = s.after_own - share;
        let rate = vat_rate(conn, s.tax_code_id, date, registered)?;
        let net = mul_div_round(amount, WHOLE, WHOLE + rate);
        priced.push(SaleLine {
            item_id: line.item_id,
            unit: line.unit.clone(),
            quantity: s.quantity,
            unit_price: s.price,
            gross: s.gross,
            discount: s.own + share,
            amount,
            net,
            vat_rate: rate,
            vat: amount - net,
        });
    }
    let net = priced.iter().map(|l| l.net).sum::<i64>();
    let vat = priced.iter().map(|l| l.vat).sum::<i64>();
    Ok(PricedSale {
        gross: priced.iter().map(|l| l.gross).sum(),
        discount: priced.iter().map(|l| l.discount).sum(),
        net,
        vat,
        total: net + vat,
        lines: priced,
    })
}

struct Settled {
    /** cash (after change), card, wallet */
    applied: [Piastres; 3],
    cash_received: Piastres,
    change: Piastres,
    on_credit: Piastres,
}

/** Tenders per method, the change from cash, and what is left on credit. */
fn settle(payments: &[PaymentInput], total: Piastres) -> Result<Settled> {
    let mut paid = [0i64; 3];
    for p in payments {
        let Some(i) = PAYMENT_METHODS.iter().position(|m| *m == p.method) else {
            return refuse(
                "payment_method_invalid",
                format!("Unknown payment method {}", p.method),
            );
        };
        match safe_int(p.amount) {
            Some(a) if a >= 0 => paid[i] += a,
            _ => {
                return refuse(
                    "line_amount_invalid",
                    format!("Payment {} is not whole piastres", p.amount),
                )
            }
        }
    }
    let tendered: i64 = paid.iter().sum();
    let change = (tendered - total).max(0);
    if change > paid[0] {
        return refuse("change_without_cash", "Only cash can give change");
    }
    Ok(Settled {
        applied: [paid[0] - change, paid[1], paid[2]],
        cash_received: paid[0],
        change,
        on_credit: (total - tendered).max(0),
    })
}

/** E-receipts are issued by the Rust core with #80; until then a till sale is refused while they are on. */
fn refuse_while_e_receipts_on(conn: &Connection) -> Result<()> {
    let on: Option<bool> = conn
        .query_row(
            "SELECT enabled = 1 AND receipts_enabled = 1 FROM eta_settings LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if on == Some(true) {
        return refuse(
            "not_ported",
            "E-receipts are not issued by this build yet; turn them off to use the till",
        );
    }
    Ok(())
}

/**
 * A sale at the till: Dr each tender's account (cash after change, card clearing,
 * wallet) and Receivables for any unpaid part; Cr Sales (net) and Output VAT;
 * Dr Cost of goods sold, Cr Stock at average cost. Selling more than is on hand is
 * allowed and reported in `below_zero`.
 */
pub fn post_sale(conn: &Connection, input: &SaleInput, user_id: i64) -> Result<SaleResult> {
    let shift = require_open_shift(conn, user_id)?;
    active_warehouse(conn, input.warehouse_id)?;
    if input.lines.is_empty() {
        return refuse("invoice_needs_lines", "A sale needs at least one line");
    }
    let priced = price_sale(conn, &input.date, &input.lines, input.discount.as_ref())?;
    let settled = settle(&input.payments, priced.total)?;
    let on_credit = settled.on_credit;
    if on_credit > 0 && input.customer_id.is_none() {
        return refuse(
            "payment_short",
            format!(
                "Paid {} of {}, with no customer to owe the rest",
                priced.total - on_credit,
                priced.total
            ),
        );
    }
    if let Some(customer_id) = input.customer_id {
        let customer = find_customer(conn, customer_id)?;
        if !customer.active {
            return refuse(
                "customer_inactive",
                format!("Customer {} is stopped", customer.name),
            );
        }
        check_credit_limit(
            conn,
            &customer,
            on_credit,
            input.credit_approval.as_ref(),
            "postSale",
            &find_user(conn, user_id)?.name,
        )?;
    }
    refuse_while_e_receipts_on(conn)?;

    // Cost each line in order, so two lines of the same item draw down stock one after the other.
    let mut taken: Vec<(i64, Quantity, Piastres)> = Vec::new();
    struct Out {
        base: Quantity,
        cost: Piastres,
        serials: Vec<String>,
    }
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
        outs.push(Out {
            base,
            cost,
            serials,
        });
    }
    let total_cost: Piastres = outs.iter().map(|o| o.cost).sum();

    let number = next_number(conn, "sales_receipts")?;
    let mut journal = Vec::new();
    for (i, role) in ["cash_drawer", "card_clearing", "wallet"]
        .iter()
        .enumerate()
    {
        if settled.applied[i] > 0 {
            journal.push(JournalLine::debit(
                account_by_role(conn, role)?,
                settled.applied[i],
            ));
        }
    }
    if let (true, Some(customer_id)) = (on_credit > 0, input.customer_id) {
        journal.push(JournalLine {
            customer_id: Some(customer_id),
            ..JournalLine::debit(account_by_role(conn, "receivables")?, on_credit)
        });
    }
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
            memo: format!("إيصال بيع رقم {number}"),
            lines: journal,
        },
        "sale",
    )?;
    conn.execute(
        "INSERT INTO sales_receipts (number, date, at, warehouse_id, entry_id, user_id, cash_received, shift_id, customer_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            number,
            input.date,
            now_iso(),
            input.warehouse_id,
            entry_id,
            user_id,
            settled.cash_received,
            shift.id,
            input.customer_id
        ],
    )?;
    let id = conn.last_insert_rowid();
    for (i, method) in PAYMENT_METHODS.iter().enumerate() {
        if settled.applied[i] > 0 {
            conn.execute(
                "INSERT INTO sales_receipt_payments (receipt_id, method, amount) VALUES (?, ?, ?)",
                params![id, method, settled.applied[i]],
            )?;
        }
    }
    for (l, out) in priced.lines.iter().zip(&outs) {
        conn.execute(
            "INSERT INTO sales_receipt_lines (receipt_id, item_id, unit, quantity, unit_price, gross, discount, net, vat_rate, vat, cost)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![id, l.item_id, l.unit, l.quantity, l.unit_price, l.gross, l.discount, l.net, l.vat_rate, l.vat, out.cost],
        )?;
        let line_id = conn.last_insert_rowid();
        issue_serials(
            conn,
            l.item_id,
            &out.serials,
            &Move {
                date: &input.date,
                warehouse_id: input.warehouse_id,
                source: "sale",
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
                quantity: -out.base,
                value: -out.cost,
                source: "sale",
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
    Ok(SaleResult {
        id,
        number,
        total: priced.total,
        change: settled.change,
        below_zero,
    })
}

/** A sale paid entirely in cash. */
pub fn post_cash_sale(
    conn: &Connection,
    input: &CashSaleInput,
    user_id: i64,
) -> Result<SaleResult> {
    post_sale(
        conn,
        &SaleInput {
            date: input.date.clone(),
            warehouse_id: input.warehouse_id,
            lines: input.lines.clone(),
            payments: vec![PaymentInput {
                method: "cash".into(),
                amount: input.cash_received,
            }],
            ..Default::default()
        },
        user_id,
    )
}

const SELECT_RECEIPTS: &str = "
  SELECT r.id, r.number, r.date, r.at, r.warehouse_id, r.cash_received, r.customer_id, u.name,
         r.eta_uuid, r.eta_previous_uuid, r.eta_status
    FROM sales_receipts r JOIN users u ON u.id = r.user_id";

struct ReceiptRow {
    id: i64,
    number: i64,
    date: String,
    at: String,
    warehouse_id: i64,
    cash_received: i64,
    customer_id: Option<i64>,
    sold_by: String,
    eta: EtaState,
}

fn receipt_row(r: &rusqlite::Row) -> rusqlite::Result<ReceiptRow> {
    Ok(ReceiptRow {
        id: r.get(0)?,
        number: r.get(1)?,
        date: r.get(2)?,
        at: r.get(3)?,
        warehouse_id: r.get(4)?,
        cash_received: r.get(5)?,
        customer_id: r.get(6)?,
        sold_by: r.get(7)?,
        eta: EtaState {
            uuid: r.get(8)?,
            previous_uuid: r.get(9)?,
            status: r.get(10)?,
        },
    })
}

fn to_receipt(conn: &Connection, r: ReceiptRow) -> Result<Receipt> {
    let mut stmt = conn.prepare_cached(
        "SELECT l.id, l.item_id, i.name_ar, i.name_en, l.unit, l.quantity, l.unit_price, l.gross, l.discount,
                l.gross - l.discount, l.net, l.vat_rate, l.vat, l.cost,
                COALESCE((SELECT SUM(x.quantity) FROM sales_return_lines x WHERE x.receipt_line_id = l.id), 0)
           FROM sales_receipt_lines l JOIN items i ON i.id = l.item_id
          WHERE l.receipt_id = ? ORDER BY l.id",
    )?;
    let rows = stmt
        .query_map([r.id], |x| {
            Ok(ReceiptLine {
                line_id: x.get(0)?,
                item_id: x.get(1)?,
                name_ar: x.get(2)?,
                name_en: x.get(3)?,
                unit: x.get(4)?,
                quantity: x.get(5)?,
                unit_price: x.get(6)?,
                gross: x.get(7)?,
                discount: x.get(8)?,
                amount: x.get(9)?,
                net: x.get(10)?,
                vat_rate: x.get(11)?,
                vat: x.get(12)?,
                cost: x.get(13)?,
                returned: x.get(14)?,
                serials: Vec::new(),
                warranty_ends: None,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut lines = Vec::with_capacity(rows.len());
    for mut l in rows {
        l.serials = serials_on_line(conn, "sale", r.id, l.line_id)?;
        if !l.serials.is_empty() {
            l.warranty_ends = warranty_end(conn, l.item_id, &r.date)?;
        }
        lines.push(l);
    }
    let payments = conn
        .prepare_cached(
            "SELECT method, amount FROM sales_receipt_payments WHERE receipt_id = ? ORDER BY id",
        )?
        .query_map([r.id], |x| {
            Ok(Payment {
                method: x.get(0)?,
                amount: x.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let paid_total: i64 = payments.iter().map(|p| p.amount).sum();
    let cash_applied = payments
        .iter()
        .find(|p| p.method == "cash")
        .map_or(0, |p| p.amount);
    let net: i64 = lines.iter().map(|l| l.net).sum();
    let vat: i64 = lines.iter().map(|l| l.vat).sum();
    Ok(Receipt {
        id: r.id,
        number: r.number,
        date: r.date,
        at: r.at,
        warehouse_id: r.warehouse_id,
        net,
        vat,
        total: net + vat,
        cash_received: r.cash_received,
        change: r.cash_received - cash_applied,
        payments,
        on_credit: net + vat - paid_total,
        customer_id: r.customer_id,
        sold_by: r.sold_by,
        eta: r.eta,
        lines,
    })
}

/** Receipts, newest first. */
pub fn list_receipts(conn: &Connection, limit: i64) -> Result<Vec<Receipt>> {
    let rows = conn
        .prepare(&format!("{SELECT_RECEIPTS} ORDER BY r.number DESC LIMIT ?"))?
        .query_map([limit], receipt_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter().map(|r| to_receipt(conn, r)).collect()
}

/** One receipt by its printed number, with how much of each line was already returned. */
pub fn find_receipt(conn: &Connection, number: i64) -> Result<Receipt> {
    let row = conn
        .query_row(
            &format!("{SELECT_RECEIPTS} WHERE r.number = ?"),
            [number],
            receipt_row,
        )
        .optional()?;
    match row {
        Some(r) => to_receipt(conn, r),
        None => refuse("receipt_not_found", format!("No receipt number {number}")),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeldSaleInput {
    pub warehouse_id: i64,
    pub lines: Vec<SaleLineInput>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discount: Option<Discount>,
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeldSale {
    pub id: i64,
    pub at: String,
    pub note: String,
    pub held_by: String,
    pub warehouse_id: i64,
    pub lines: Vec<SaleLineInput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub discount: Option<Discount>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cart {
    warehouse_id: i64,
    lines: Vec<SaleLineInput>,
    #[serde(default)]
    discount: Option<Discount>,
}

/** Puts a cart aside: nothing is posted and no receipt number is used. */
pub fn hold_sale(conn: &Connection, user_id: i64, input: &HeldSaleInput) -> Result<i64> {
    if input.lines.is_empty() {
        return refuse("invoice_needs_lines", "A held sale needs at least one line");
    }
    for l in &input.lines {
        assert_quantity(l.quantity)?;
    }
    let mut cart = serde_json::json!({ "warehouseId": input.warehouse_id, "lines": input.lines });
    if let Some(d) = &input.discount {
        cart["discount"] = serde_json::to_value(d).unwrap_or(Value::Null);
    }
    conn.execute(
        "INSERT INTO held_sales (user_id, at, note, cart) VALUES (?, ?, ?, ?)",
        params![
            user_id,
            now_iso(),
            input.note.trim(),
            crate::num::tidy(cart).to_string()
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

const SELECT_HELD: &str =
    "SELECT h.id, h.at, h.note, h.cart, u.name FROM held_sales h JOIN users u ON u.id = h.user_id";

fn held_row(r: &rusqlite::Row) -> rusqlite::Result<(i64, String, String, String, String)> {
    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
}

fn to_held(
    (id, at, note, cart, held_by): (i64, String, String, String, String),
) -> Result<HeldSale> {
    let cart: Cart = serde_json::from_str(&cart).map_err(|e| {
        crate::error::BusinessError::new("held_sale_not_found", format!("Held sale {id}: {e}"))
    })?;
    Ok(HeldSale {
        id,
        at,
        note,
        held_by,
        warehouse_id: cart.warehouse_id,
        lines: cart.lines,
        discount: cart.discount,
    })
}

/** Held carts, oldest first. */
pub fn list_held_sales(conn: &Connection) -> Result<Vec<HeldSale>> {
    let rows = conn
        .prepare(&format!("{SELECT_HELD} ORDER BY h.id"))?
        .query_map([], held_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter().map(to_held).collect()
}

/** Takes a held cart back to the till; it is no longer held. */
pub fn recall_sale(conn: &Connection, id: i64) -> Result<HeldSale> {
    let row = conn
        .query_row(&format!("{SELECT_HELD} WHERE h.id = ?"), [id], held_row)
        .optional()?;
    let Some(row) = row else {
        return refuse("held_sale_not_found", format!("No held sale with id {id}"));
    };
    conn.execute("DELETE FROM held_sales WHERE id = ?", [id])?;
    to_held(row)
}
