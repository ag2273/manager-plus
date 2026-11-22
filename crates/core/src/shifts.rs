//! Till shifts: the opening float, cash in and out of the drawer, the Z report and closing.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::dates::assert_iso_date;
use crate::error::{refuse, Result};
use crate::ledger::{post_journal_entry, JournalEntryInput, JournalLine, Piastres};
use crate::num::safe_int;
use crate::stock::account_by_role;
use crate::users::now_iso;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shift {
    pub id: i64,
    pub user_id: i64,
    pub user_name: String,
    pub opened_at: String,
    pub opening_float: Piastres,
    pub closed_at: Option<String>,
    pub counted_cash: Option<Piastres>,
    pub status: &'static str,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CashInOut {
    pub date: String,
    /** "in" or "out". */
    pub direction: String,
    pub amount: f64,
    pub account_id: i64,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseShiftInput {
    pub date: String,
    pub counted_cash: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ByMethod {
    pub cash: Piastres,
    pub card: Piastres,
    pub wallet: Piastres,
    /** What was left on customers' accounts. */
    pub credit: Piastres,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftSales {
    pub total: Piastres,
    pub net: Piastres,
    pub vat: Piastres,
    /** Cash is after change. */
    pub by_method: ByMethod,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZReport {
    pub shift: Shift,
    pub receipts: i64,
    pub sales: ShiftSales,
    pub returns: Piastres,
    pub discounts: Piastres,
    pub cash_in: Piastres,
    pub cash_out: Piastres,
    pub opening_float: Piastres,
    /** Float + cash taken for sales − cash refunds + cash in − cash out. */
    pub expected_cash: Piastres,
    pub counted_cash: Option<Piastres>,
    /** Counted − expected: positive is cash over, negative cash short. */
    pub difference: Option<Piastres>,
}

const SELECT_SHIFTS: &str = "
  SELECT s.id, s.user_id, u.name, s.opened_at, s.opening_float, s.closed_at, s.counted_cash
    FROM shifts s JOIN users u ON u.id = s.user_id";

fn to_shift(r: &Row) -> rusqlite::Result<Shift> {
    let closed_at: Option<String> = r.get(5)?;
    Ok(Shift {
        id: r.get(0)?,
        user_id: r.get(1)?,
        user_name: r.get(2)?,
        opened_at: r.get(3)?,
        opening_float: r.get(4)?,
        status: if closed_at.is_none() {
            "open"
        } else {
            "closed"
        },
        closed_at,
        counted_cash: r.get(6)?,
    })
}

fn assert_amount(amount: f64) -> Result<Piastres> {
    match safe_int(amount) {
        Some(a) if a >= 0 => Ok(a),
        _ => refuse(
            "line_amount_invalid",
            format!("Amount {amount} is not whole piastres"),
        ),
    }
}

pub fn open_shift_of(conn: &Connection, user_id: i64) -> Result<Option<Shift>> {
    Ok(conn
        .query_row(
            &format!("{SELECT_SHIFTS} WHERE s.user_id = ? AND s.closed_at IS NULL"),
            [user_id],
            to_shift,
        )
        .optional()?)
}

/** The user's open shift; every till command needs one. */
pub fn require_open_shift(conn: &Connection, user_id: i64) -> Result<Shift> {
    match open_shift_of(conn, user_id)? {
        Some(s) => Ok(s),
        None => refuse("shift_required", "Open a shift first"),
    }
}

pub fn open_shift(conn: &Connection, user_id: i64, opening_float: f64) -> Result<i64> {
    let opening_float = assert_amount(opening_float)?;
    if open_shift_of(conn, user_id)?.is_some() {
        return refuse("shift_already_open", "This user already has an open shift");
    }
    conn.execute(
        "INSERT INTO shifts (user_id, opened_at, opening_float) VALUES (?, ?, ?)",
        params![user_id, now_iso(), opening_float],
    )?;
    Ok(conn.last_insert_rowid())
}

/** Cash paid into the drawer (Dr Cash drawer, Cr account) or out of it (Dr account, Cr Cash drawer). */
pub fn cash_in_out(conn: &Connection, user_id: i64, input: &CashInOut) -> Result<i64> {
    assert_iso_date(&input.date)?;
    let shift = require_open_shift(conn, user_id)?;
    let amount = match safe_int(input.amount) {
        Some(a) if a > 0 => a,
        _ => {
            return refuse(
                "line_amount_invalid",
                format!(
                    "Amount {} is not a positive whole number of piastres",
                    input.amount
                ),
            )
        }
    };
    let drawer = account_by_role(conn, "cash_drawer")?;
    if input.account_id == drawer {
        return refuse(
            "account_not_allowed",
            "Pick the account the cash comes from or goes to",
        );
    }
    let reason = input.reason.trim();
    let into = input.direction == "in";
    let lines = if into {
        vec![
            JournalLine::debit(drawer, amount),
            JournalLine::credit(input.account_id, amount),
        ]
    } else {
        vec![
            JournalLine::debit(input.account_id, amount),
            JournalLine::credit(drawer, amount),
        ]
    };
    let mut memo = String::from(if into {
        "إيداع في الدرج"
    } else {
        "صرف من الدرج"
    });
    if !reason.is_empty() {
        memo.push_str(": ");
        memo.push_str(reason);
    }
    let entry_id = post_journal_entry(
        conn,
        &JournalEntryInput {
            date: input.date.clone(),
            memo,
            lines,
        },
        "cash_movement",
    )?;
    conn.execute(
        "INSERT INTO cash_movements (shift_id, at, direction, amount, account_id, reason, entry_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        params![shift.id, now_iso(), if into { "in" } else { "out" }, amount, input.account_id, reason, entry_id],
    )?;
    Ok(conn.last_insert_rowid())
}

fn find_shift(conn: &Connection, id: i64) -> Result<Shift> {
    match conn
        .query_row(&format!("{SELECT_SHIFTS} WHERE s.id = ?"), [id], to_shift)
        .optional()?
    {
        Some(s) => Ok(s),
        None => refuse("shift_not_found", format!("No shift with id {id}")),
    }
}

pub fn z_report(conn: &Connection, id: i64) -> Result<ZReport> {
    let shift = find_shift(conn, id)?;
    let (receipts, total, discounts, net, vat): (i64, i64, i64, i64, i64) = conn.query_row(
        "SELECT COUNT(DISTINCT r.id), COALESCE(SUM(l.gross - l.discount), 0), COALESCE(SUM(l.discount), 0),
                COALESCE(SUM(l.net), 0), COALESCE(SUM(l.vat), 0)
           FROM sales_receipts r LEFT JOIN sales_receipt_lines l ON l.receipt_id = r.id
          WHERE r.shift_id = ?",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    )?;
    let mut by_method = ByMethod::default();
    let mut stmt = conn.prepare(
        "SELECT p.method, SUM(p.amount) FROM sales_receipt_payments p JOIN sales_receipts r ON r.id = p.receipt_id
          WHERE r.shift_id = ? GROUP BY p.method",
    )?;
    let paid = stmt.query_map([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    for p in paid {
        let (method, amount) = p?;
        match method.as_str() {
            "cash" => by_method.cash = amount,
            "card" => by_method.card = amount,
            _ => by_method.wallet = amount,
        }
    }
    by_method.credit = total - by_method.cash - by_method.card - by_method.wallet;
    let (cash_in, cash_out): (i64, i64) = conn.query_row(
        "SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN amount END), 0),
                COALESCE(SUM(CASE WHEN direction = 'out' THEN amount END), 0)
           FROM cash_movements WHERE shift_id = ?",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let (returns, cash_returns): (i64, i64) = conn.query_row(
        "SELECT COALESCE(SUM(l.amount), 0), COALESCE(SUM(CASE WHEN r.refund = 'cash' THEN l.amount END), 0)
           FROM sales_returns r JOIN sales_return_lines l ON l.return_id = r.id
          WHERE r.shift_id = ?",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let expected_cash = shift.opening_float + by_method.cash - cash_returns + cash_in - cash_out;
    Ok(ZReport {
        receipts,
        sales: ShiftSales {
            total,
            net,
            vat,
            by_method,
        },
        returns,
        discounts,
        cash_in,
        cash_out,
        opening_float: shift.opening_float,
        expected_cash,
        counted_cash: shift.counted_cash,
        difference: shift.counted_cash.map(|c| c - expected_cash),
        shift,
    })
}

/** Closes the user's shift with the cash counted; the difference posts to Cash over or Cash short. */
pub fn close_shift(conn: &Connection, user_id: i64, input: &CloseShiftInput) -> Result<ZReport> {
    assert_iso_date(&input.date)?;
    let counted = assert_amount(input.counted_cash)?;
    let shift = require_open_shift(conn, user_id)?;
    let difference = counted - z_report(conn, shift.id)?.expected_cash;
    let mut entry_id = None;
    if difference != 0 {
        let drawer = account_by_role(conn, "cash_drawer")?;
        let lines = if difference > 0 {
            vec![
                JournalLine::debit(drawer, difference),
                JournalLine::credit(account_by_role(conn, "cash_over")?, difference),
            ]
        } else {
            vec![
                JournalLine::debit(account_by_role(conn, "cash_short")?, -difference),
                JournalLine::credit(drawer, -difference),
            ]
        };
        entry_id = Some(post_journal_entry(
            conn,
            &JournalEntryInput {
                date: input.date.clone(),
                memo: format!("إغلاق وردية رقم {}", shift.id),
                lines,
            },
            "shift_close",
        )?);
    }
    conn.execute(
        "UPDATE shifts SET closed_at = ?, counted_cash = ?, close_entry_id = ? WHERE id = ?",
        params![now_iso(), counted, entry_id, shift.id],
    )?;
    z_report(conn, shift.id)
}

/** Shifts, newest first. */
pub fn list_shifts(conn: &Connection, limit: i64) -> Result<Vec<Shift>> {
    let mut stmt = conn.prepare(&format!("{SELECT_SHIFTS} ORDER BY s.id DESC LIMIT ?"))?;
    let rows = stmt.query_map([limit], to_shift)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}
