//! Cash, bank and wallet accounts: expenses, transfers, bank reconciliation, the lock date and
//! voiding entries that have no document of their own.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::dates::assert_iso_date;
use crate::error::{refuse, Result};
use crate::ledger::{post_journal_entry, JournalEntryInput, JournalLine, Piastres};
use crate::num::safe_int;
use crate::purchases::{assert_postable, find_supplier};
use crate::shares::next_number;
use crate::stock::account_by_role;

/** Cash, bank and wallet accounts: the system ones, and any asset account the user adds in the 11xx cash and bank group. */
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MoneyAccount {
    pub id: i64,
    pub code: String,
    pub name: String,
    pub balance: Piastres,
}

/** Paid from a money account now, or owed to a supplier. */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum PaidFrom {
    Account { account_id: i64 },
    Supplier { supplier_id: i64 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpenseInput {
    pub date: String,
    /** An expense account from the chart. */
    pub expense_account_id: i64,
    /** Without VAT. */
    pub amount: f64,
    /** Input VAT on the bill, if any. */
    pub vat: f64,
    pub paid_from: PaidFrom,
    pub memo: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Expense {
    pub id: i64,
    pub number: i64,
    pub date: String,
    pub account_name: String,
    pub amount: Piastres,
    pub vat: Piastres,
    /** The money account or supplier's name. */
    pub paid_from: String,
    pub memo: String,
    pub entry_id: i64,
    pub voided: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoneyTransferInput {
    pub date: String,
    pub from_account_id: i64,
    pub to_account_id: i64,
    pub amount: f64,
    pub memo: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoneyTransfer {
    pub id: i64,
    pub number: i64,
    pub date: String,
    pub from: String,
    pub to: String,
    pub amount: Piastres,
    pub memo: String,
    pub entry_id: i64,
    pub voided: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostedDocument {
    pub id: i64,
    pub number: i64,
    pub entry_id: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountLine {
    pub line_id: i64,
    pub entry_id: i64,
    pub date: String,
    pub memo: String,
    pub debit: Piastres,
    pub credit: Piastres,
    pub cleared: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Reconciliation {
    /** Every posting to the account. */
    pub balance: Piastres,
    /** The lines ticked as on the bank statement. */
    pub cleared: Piastres,
    pub statement: Piastres,
    /** Statement less cleared: zero when the ticked lines match the statement. */
    pub difference: Piastres,
}

/** Entries with no document of their own behind them, so voiding the entry voids the whole thing. */
const VOIDABLE: [&str; 3] = ["journal", "expense", "money_transfer"];

const MONEY_WHERE: &str = "a.active = 1 AND a.type = 'asset' AND (a.role IN ('cash_drawer', 'main_cash', 'bank', 'wallet', 'card_clearing') OR (a.role IS NULL AND a.code LIKE '11%'))";

pub fn list_money_accounts(conn: &Connection, as_of: &str) -> Result<Vec<MoneyAccount>> {
    assert_iso_date(as_of)?;
    let rows = conn
        .prepare(&format!(
            "SELECT a.id, a.code, a.name,
                    COALESCE((SELECT SUM(l.debit) - SUM(l.credit) FROM ledger_lines l JOIN journal_entries e ON e.id = l.entry_id
                               WHERE l.account_id = a.id AND e.date <= ?), 0)
               FROM accounts a WHERE {MONEY_WHERE} ORDER BY a.code"
        ))?
        .query_map([as_of], |r| {
            Ok(MoneyAccount {
                id: r.get(0)?,
                code: r.get(1)?,
                name: r.get(2)?,
                balance: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

fn money_account(conn: &Connection, id: i64) -> Result<(i64, String)> {
    let row = conn
        .query_row(
            &format!("SELECT a.id, a.name FROM accounts a WHERE a.id = ? AND {MONEY_WHERE}"),
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match row {
        Some(row) => Ok(row),
        None => refuse(
            "account_not_allowed",
            format!("Account {id} is not a cash, bank or wallet account"),
        ),
    }
}

fn assert_amount(amount: f64, allow_zero: bool) -> Result<Piastres> {
    match safe_int(amount) {
        Some(a) if a > 0 || (allow_zero && a == 0) => Ok(a),
        _ => refuse(
            "amount_invalid",
            format!("Amount {amount} is not whole piastres"),
        ),
    }
}

fn with_memo(text: String, memo: &str) -> String {
    if memo.is_empty() {
        text
    } else {
        format!("{text} - {memo}")
    }
}

/** An expense: Dr the expense account (and Input VAT), Cr the money account it was paid from or the supplier owed. */
pub fn record_expense(
    conn: &Connection,
    input: &ExpenseInput,
    user_id: i64,
) -> Result<PostedDocument> {
    assert_iso_date(&input.date)?;
    let amount = assert_amount(input.amount, false)?;
    let vat = assert_amount(input.vat, true)?;
    let expense = conn
        .query_row(
            "SELECT id FROM accounts WHERE id = ? AND type = 'expense' AND active = 1",
            [input.expense_account_id],
            |_| Ok(()),
        )
        .optional()?;
    if expense.is_none() {
        return refuse(
            "account_not_allowed",
            format!(
                "Account {} is not an expense account",
                input.expense_account_id
            ),
        );
    }
    let total = amount + vat;
    let (credit, money_account_id, supplier_id, name) = match input.paid_from {
        PaidFrom::Supplier { supplier_id } => {
            let supplier = find_supplier(conn, supplier_id)?;
            assert_postable(&supplier)?;
            if supplier.currency != "EGP" {
                return refuse(
                    "payee_not_egp",
                    format!("{} bills in {}", supplier.name, supplier.currency),
                );
            }
            (
                JournalLine {
                    supplier_id: Some(supplier.id),
                    ..JournalLine::credit(account_by_role(conn, "payables")?, total)
                },
                None,
                Some(supplier.id),
                supplier.name,
            )
        }
        PaidFrom::Account { account_id } => {
            let (id, name) = money_account(conn, account_id)?;
            (JournalLine::credit(id, total), Some(id), None, name)
        }
    };
    let number = next_number(conn, "expenses")?;
    let memo = input.memo.trim();
    let mut lines = vec![JournalLine::debit(input.expense_account_id, amount)];
    if vat > 0 {
        lines.push(JournalLine::debit(account_by_role(conn, "input_vat")?, vat));
    }
    lines.push(credit);
    let entry_id = post_journal_entry(
        conn,
        &JournalEntryInput {
            date: input.date.clone(),
            memo: with_memo(format!("مصروف رقم {number} - {name}"), memo),
            lines,
        },
        "expense",
    )?;
    conn.execute(
        "INSERT INTO expenses (number, date, account_id, amount, vat, money_account_id, supplier_id, memo, entry_id, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            number,
            input.date,
            input.expense_account_id,
            amount,
            vat,
            money_account_id,
            supplier_id,
            memo,
            entry_id,
            user_id
        ],
    )?;
    Ok(PostedDocument {
        id: conn.last_insert_rowid(),
        number,
        entry_id,
    })
}

pub fn list_expenses(conn: &Connection) -> Result<Vec<Expense>> {
    let rows = conn
        .prepare(
            "SELECT x.id, x.number, x.date, a.name, x.amount, x.vat, COALESCE(m.name, s.name), x.memo, x.entry_id,
                    e.voided_by IS NOT NULL
               FROM expenses x JOIN accounts a ON a.id = x.account_id JOIN journal_entries e ON e.id = x.entry_id
               LEFT JOIN accounts m ON m.id = x.money_account_id LEFT JOIN suppliers s ON s.id = x.supplier_id
              ORDER BY x.number DESC",
        )?
        .query_map([], |r| {
            Ok(Expense {
                id: r.get(0)?,
                number: r.get(1)?,
                date: r.get(2)?,
                account_name: r.get(3)?,
                amount: r.get(4)?,
                vat: r.get(5)?,
                paid_from: r.get(6)?,
                memo: r.get(7)?,
                entry_id: r.get(8)?,
                voided: r.get(9)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/** Money moved between two of the business's own accounts: Dr the one it goes into, Cr the one it leaves. */
pub fn transfer_money(
    conn: &Connection,
    input: &MoneyTransferInput,
    user_id: i64,
) -> Result<PostedDocument> {
    assert_iso_date(&input.date)?;
    let amount = assert_amount(input.amount, false)?;
    let (from, from_name) = money_account(conn, input.from_account_id)?;
    let (to, to_name) = money_account(conn, input.to_account_id)?;
    if from == to {
        return refuse(
            "account_not_allowed",
            "A transfer needs two different accounts",
        );
    }
    let number = next_number(conn, "money_transfers")?;
    let memo = input.memo.trim();
    let entry_id = post_journal_entry(
        conn,
        &JournalEntryInput {
            date: input.date.clone(),
            memo: with_memo(
                format!("تحويل رقم {number} من {from_name} إلى {to_name}"),
                memo,
            ),
            lines: vec![
                JournalLine::debit(to, amount),
                JournalLine::credit(from, amount),
            ],
        },
        "money_transfer",
    )?;
    conn.execute(
        "INSERT INTO money_transfers (number, date, from_account_id, to_account_id, amount, memo, entry_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        params![number, input.date, from, to, amount, memo, entry_id, user_id],
    )?;
    Ok(PostedDocument {
        id: conn.last_insert_rowid(),
        number,
        entry_id,
    })
}

pub fn list_money_transfers(conn: &Connection) -> Result<Vec<MoneyTransfer>> {
    let rows = conn
        .prepare(
            "SELECT t.id, t.number, t.date, f.name, o.name, t.amount, t.memo, t.entry_id, e.voided_by IS NOT NULL
               FROM money_transfers t JOIN accounts f ON f.id = t.from_account_id JOIN accounts o ON o.id = t.to_account_id
               JOIN journal_entries e ON e.id = t.entry_id
              ORDER BY t.number DESC",
        )?
        .query_map([], |r| {
            Ok(MoneyTransfer {
                id: r.get(0)?,
                number: r.get(1)?,
                date: r.get(2)?,
                from: r.get(3)?,
                to: r.get(4)?,
                amount: r.get(5)?,
                memo: r.get(6)?,
                entry_id: r.get(7)?,
                voided: r.get(8)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/** Every posting to an account between two dates, with whether it is ticked as on the statement. */
pub fn account_lines(
    conn: &Connection,
    account_id: i64,
    from: &str,
    to: &str,
) -> Result<Vec<AccountLine>> {
    assert_iso_date(from)?;
    assert_iso_date(to)?;
    if from > to {
        return refuse("date_range_invalid", format!("{from} is after {to}"));
    }
    let rows = conn
        .prepare(
            "SELECT l.id, e.id, e.date, e.memo, l.debit, l.credit, l.cleared
               FROM ledger_lines l JOIN journal_entries e ON e.id = l.entry_id
              WHERE l.account_id = ? AND e.date BETWEEN ? AND ?
              ORDER BY e.date, l.id",
        )?
        .query_map(params![account_id, from, to], |r| {
            Ok(AccountLine {
                line_id: r.get(0)?,
                entry_id: r.get(1)?,
                date: r.get(2)?,
                memo: r.get(3)?,
                debit: r.get(4)?,
                credit: r.get(5)?,
                cleared: r.get::<_, i64>(6)? == 1,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn set_cleared(
    conn: &Connection,
    account_id: i64,
    line_ids: &[i64],
    cleared: bool,
) -> Result<()> {
    for &id in line_ids {
        let owner: Option<i64> = conn
            .query_row(
                "SELECT account_id FROM ledger_lines WHERE id = ?",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        if owner != Some(account_id) {
            return refuse(
                "line_not_found",
                format!("Line {id} is not on account {account_id}"),
            );
        }
        conn.execute(
            "UPDATE ledger_lines SET cleared = ? WHERE id = ?",
            params![cleared as i64, id],
        )?;
    }
    Ok(())
}

pub fn reconciliation(
    conn: &Connection,
    account_id: i64,
    statement: f64,
) -> Result<Reconciliation> {
    let Some(statement) = safe_int(statement) else {
        return refuse(
            "amount_invalid",
            format!("Statement balance {statement} is not whole piastres"),
        );
    };
    let (balance, cleared): (i64, i64) = conn.query_row(
        "SELECT COALESCE(SUM(debit) - SUM(credit), 0),
                COALESCE(SUM(CASE WHEN cleared = 1 THEN debit - credit ELSE 0 END), 0)
           FROM ledger_lines WHERE account_id = ?",
        [account_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok(Reconciliation {
        balance,
        cleared,
        statement,
        difference: statement - cleared,
    })
}

pub fn lock_date(conn: &Connection) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT lock_date FROM business_settings WHERE id = 1",
            [],
            |r| r.get(0),
        )
        .optional()?
        .flatten())
}

pub fn set_lock_date(conn: &Connection, date: Option<&str>) -> Result<()> {
    if let Some(date) = date {
        assert_iso_date(date)?;
    }
    conn.execute(
        "UPDATE business_settings SET lock_date = ? WHERE id = 1",
        [date],
    )?;
    Ok(())
}

/**
 * Voids a journal entry, an expense or a transfer by posting its reverse on `date`. Both stay in
 * the ledger, so the history shows what was posted and when it was undone; to edit, void and
 * post again. Documents with their own undo (invoices, receipts, sales) are refused.
 */
pub fn void_entry(conn: &Connection, entry_id: i64, date: &str) -> Result<i64> {
    assert_iso_date(date)?;
    let entry: Option<(String, String, String, Option<i64>)> = conn
        .query_row(
            "SELECT date, memo, kind, voided_by FROM journal_entries WHERE id = ?",
            [entry_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((entry_date, memo, kind, voided_by)) = entry else {
        return refuse(
            "entry_not_found",
            format!("No journal entry with id {entry_id}"),
        );
    };
    if !VOIDABLE.contains(&kind.as_str()) {
        return refuse(
            "entry_not_voidable",
            format!("A {kind} entry is undone through its own document"),
        );
    }
    if voided_by.is_some() {
        return refuse("entry_voided", format!("Entry {entry_id} is already void"));
    }
    if date < entry_date.as_str() {
        return refuse(
            "date_range_invalid",
            format!("The void date {date} is before the entry's {entry_date}"),
        );
    }
    let reversed: Vec<JournalLine> = conn
        .prepare(
            "SELECT account_id, debit, credit, memo, supplier_id, customer_id, foreign_amount
               FROM ledger_lines WHERE entry_id = ? ORDER BY id",
        )?
        .query_map([entry_id], |r| {
            let debit: i64 = r.get(1)?;
            let credit: i64 = r.get(2)?;
            let (debit, credit) = if debit > 0 {
                (None, Some(debit as f64))
            } else {
                (Some(credit as f64), None)
            };
            Ok(JournalLine {
                account_id: r.get(0)?,
                debit,
                credit,
                memo: r.get(3)?,
                supplier_id: r.get(4)?,
                customer_id: r.get(5)?,
                foreign: r.get::<_, Option<i64>>(6)?.map(|f| f as f64),
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let reversal = post_journal_entry(
        conn,
        &JournalEntryInput {
            date: date.into(),
            memo: format!("إلغاء: {memo}"),
            lines: reversed,
        },
        "reversal",
    )?;
    conn.execute(
        "UPDATE journal_entries SET voided_by = ? WHERE id = ?",
        params![reversal, entry_id],
    )?;
    Ok(reversal)
}
