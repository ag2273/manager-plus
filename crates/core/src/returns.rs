//! Customers bringing till sales back, against the receipt they were sold on.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::dates::assert_iso_date;
use crate::error::{refuse, Result};
use crate::items::Quantity;
use crate::ledger::{post_journal_entry, JournalEntryInput, JournalLine, Piastres};
use crate::num::mul_div_round;
use crate::serials::{return_serials, serials_for, Move};
use crate::shares::{next_number, share_of, take, Taken};
use crate::shifts::require_open_shift;
use crate::stock::{account_by_role, assert_quantity, insert_movement, NewMovement};
use crate::users::now_iso;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReturnLineInput {
    pub line_id: i64,
    /** How much comes back, in thousandths of the line's unit. */
    pub quantity: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serials: Option<Vec<String>>,
}

impl ReturnLineInput {
    pub fn new(line_id: i64, quantity: Quantity) -> Self {
        ReturnLineInput {
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
pub struct ReturnInput {
    pub date: String,
    pub receipt_id: i64,
    pub lines: Vec<ReturnLineInput>,
    /** "cash" from the drawer, or "account": credited to the receipt's customer. */
    pub refund: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReturnResult {
    pub id: i64,
    pub number: i64,
    pub total: Piastres,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleReturnLine {
    pub item_id: i64,
    pub name_ar: String,
    pub name_en: String,
    pub unit: String,
    pub quantity: Quantity,
    pub amount: Piastres,
    pub vat: Piastres,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleReturn {
    pub id: i64,
    pub number: i64,
    pub date: String,
    pub at: String,
    pub receipt_number: i64,
    pub refund: String,
    pub returned_by: String,
    pub total: Piastres,
    pub vat: Piastres,
    pub lines: Vec<SaleReturnLine>,
}

const ONE_UNIT: i64 = 1000;

struct Back {
    line_id: i64,
    item_id: i64,
    quantity: Quantity,
    base: Quantity,
    amount: Piastres,
    net: Piastres,
    vat: Piastres,
    cost: Piastres,
    serials: Vec<String>,
}

/**
 * Takes items back against the receipt they were sold on, at that sale's price, VAT
 * and cost: Dr Sales, Dr Output VAT, Cr Cash drawer or Receivables; Dr Stock, Cr Cost
 * of goods sold; stock back into the warehouse it was sold from.
 */
pub fn return_sale(conn: &Connection, input: &ReturnInput, user_id: i64) -> Result<ReturnResult> {
    return_to(conn, input, user_id, None)
}

/** A return whose refund to account goes to `credit_to` instead of the receipt's own customer. */
pub(crate) fn return_to(
    conn: &Connection,
    input: &ReturnInput,
    user_id: i64,
    credit_to: Option<i64>,
) -> Result<ReturnResult> {
    assert_iso_date(&input.date)?;
    let shift = require_open_shift(conn, user_id)?;
    let receipt: Option<(i64, i64, i64, Option<i64>)> = conn
        .query_row(
            "SELECT id, number, warehouse_id, customer_id FROM sales_receipts WHERE id = ?",
            [input.receipt_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((receipt_id, receipt_number, warehouse_id, customer_id)) = receipt else {
        return refuse(
            "receipt_not_found",
            format!("No receipt with id {}", input.receipt_id),
        );
    };
    let customer_id = credit_to.or(customer_id);
    if input.lines.is_empty() {
        return refuse("invoice_needs_lines", "A return needs at least one line");
    }
    let to_account = input.refund == "account";
    if to_account && customer_id.is_none() {
        return refuse(
            "customer_not_found",
            "This receipt has no customer to credit",
        );
    }

    let mut taken: Vec<(i64, Taken)> = Vec::new();
    let mut backs = Vec::with_capacity(input.lines.len());
    for given in &input.lines {
        let quantity = assert_quantity(given.quantity)?;
        let line: Option<(i64, i64, i64, i64, i64, i64)> = conn
            .query_row(
                "SELECT l.item_id, l.quantity, l.gross - l.discount, l.net, l.cost, COALESCE(u.size, 1000)
                   FROM sales_receipt_lines l LEFT JOIN item_units u ON u.item_id = l.item_id AND u.kind = l.unit
                  WHERE l.id = ? AND l.receipt_id = ?",
                params![given.line_id, receipt_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .optional()?;
        let Some((item_id, sold, amount, net, cost, size)) = line else {
            return refuse(
                "return_line_invalid",
                format!("Line {} is not on receipt {receipt_number}", given.line_id),
            );
        };
        let before = match taken.iter().find(|t| t.0 == given.line_id) {
            Some((_, t)) => t.clone(),
            None => conn.query_row(
                "SELECT COALESCE(SUM(quantity), 0), COALESCE(SUM(amount), 0), COALESCE(SUM(net), 0), COALESCE(SUM(cost), 0)
                   FROM sales_return_lines WHERE receipt_line_id = ?",
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
                    "Only {} of line {} can still be returned",
                    sold - before.quantity,
                    given.line_id
                ),
            );
        }
        let share = share_of(&[amount, net, cost], sold, &before, quantity);
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
            amount: share[0],
            net: share[1],
            vat: share[0] - share[1],
            cost: share[2],
            serials: serials_for(conn, item_id, base, given.serials.as_deref())?,
        });
    }

    let total: Piastres = backs.iter().map(|b| b.amount).sum();
    let net: Piastres = backs.iter().map(|b| b.net).sum();
    let vat: Piastres = backs.iter().map(|b| b.vat).sum();
    let cost: Piastres = backs.iter().map(|b| b.cost).sum();
    let number = next_number(conn, "sales_returns")?;

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
        journal.push(match (to_account, customer_id) {
            (true, Some(customer)) => JournalLine {
                customer_id: Some(customer),
                ..JournalLine::credit(account_by_role(conn, "receivables")?, total)
            },
            _ => JournalLine::credit(account_by_role(conn, "cash_drawer")?, total),
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
            memo: format!("مرتجع رقم {number} من إيصال {receipt_number}"),
            lines: journal,
        },
        "sale_return",
    )?;
    conn.execute(
        "INSERT INTO sales_returns (number, date, at, receipt_id, shift_id, user_id, entry_id, refund)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        params![number, input.date, now_iso(), receipt_id, shift.id, user_id, entry_id, input.refund],
    )?;
    let id = conn.last_insert_rowid();
    for b in &backs {
        conn.execute(
            "INSERT INTO sales_return_lines (return_id, receipt_line_id, quantity, amount, net, vat, cost) VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![id, b.line_id, b.quantity, b.amount, b.net, b.vat, b.cost],
        )?;
        let line_id = conn.last_insert_rowid();
        return_serials(
            conn,
            b.item_id,
            &b.serials,
            ("sale", receipt_id),
            &Move {
                date: &input.date,
                warehouse_id,
                source: "sale_return",
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
                source: "sale_return",
                source_id: id,
            },
        )?;
    }
    Ok(ReturnResult { id, number, total })
}

/** One return by its printed number. */
pub fn find_return(conn: &Connection, number: i64) -> Result<SaleReturn> {
    type Head = (i64, i64, String, String, i64, String, String);
    let row: Option<Head> = conn
        .query_row(
            "SELECT x.id, x.number, x.date, x.at, r.number, x.refund, u.name
               FROM sales_returns x JOIN sales_receipts r ON r.id = x.receipt_id JOIN users u ON u.id = x.user_id
              WHERE x.number = ?",
            [number],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        )
        .optional()?;
    let Some((id, number, date, at, receipt_number, refund, returned_by)) = row else {
        return refuse("receipt_not_found", format!("No return number {number}"));
    };
    let lines = conn
        .prepare(
            "SELECT l.item_id, i.name_ar, i.name_en, l.unit, x.quantity, x.amount, x.vat
               FROM sales_return_lines x
               JOIN sales_receipt_lines l ON l.id = x.receipt_line_id
               JOIN items i ON i.id = l.item_id
              WHERE x.return_id = ? ORDER BY x.id",
        )?
        .query_map([id], |r| {
            Ok(SaleReturnLine {
                item_id: r.get(0)?,
                name_ar: r.get(1)?,
                name_en: r.get(2)?,
                unit: r.get(3)?,
                quantity: r.get(4)?,
                amount: r.get(5)?,
                vat: r.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(SaleReturn {
        id,
        number,
        date,
        at,
        receipt_number,
        refund,
        returned_by,
        total: lines.iter().map(|l| l.amount).sum(),
        vat: lines.iter().map(|l| l.vat).sum(),
        lines,
    })
}
