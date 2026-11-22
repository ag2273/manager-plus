use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::chart::ACCOUNT_TYPES;
use crate::dates::{assert_iso_date, IsoDate};
use crate::error::{refuse, BusinessError, Result};

/** Whole piastres (1/100 EGP). Never a fraction. */
pub type Piastres = i64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Account {
    pub id: i64,
    pub code: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub role: Option<String>,
    pub active: bool,
}

/**
 * A line as the screens send it. Amounts arrive as JSON numbers, so a fraction or a negative is
 * refused here rather than lost on the way in.
 */
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalLine {
    pub account_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debit: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credit: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memo: Option<String>,
    /** The supplier a payables line belongs to. */
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supplier_id: Option<i64>,
    /** The customer a receivables line belongs to. */
    #[serde(skip_serializing_if = "Option::is_none")]
    pub customer_id: Option<i64>,
    /** On a payables line of a supplier billing in another currency: the same amount in that currency. */
    #[serde(skip_serializing_if = "Option::is_none")]
    pub foreign: Option<f64>,
}

impl JournalLine {
    pub fn debit(account_id: i64, amount: Piastres) -> Self {
        JournalLine {
            account_id,
            debit: Some(amount as f64),
            ..Default::default()
        }
    }
    pub fn credit(account_id: i64, amount: Piastres) -> Self {
        JournalLine {
            account_id,
            credit: Some(amount as f64),
            ..Default::default()
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JournalEntryInput {
    pub date: IsoDate,
    pub memo: String,
    pub lines: Vec<JournalLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrialBalanceRow {
    pub account_id: i64,
    pub code: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub debit: Piastres,
    pub credit: Piastres,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrialBalance {
    pub rows: Vec<TrialBalanceRow>,
    pub total_debit: Piastres,
    pub total_credit: Piastres,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct NewAccount {
    pub code: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct AccountChanges {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

const ACCOUNT_COLUMNS: &str = "id, code, name, type, role, active";

fn to_account(r: &rusqlite::Row) -> rusqlite::Result<Account> {
    Ok(Account {
        id: r.get(0)?,
        code: r.get(1)?,
        name: r.get(2)?,
        kind: r.get(3)?,
        role: r.get(4)?,
        active: r.get::<_, i64>(5)? == 1,
    })
}

pub fn list_accounts(conn: &Connection) -> Result<Vec<Account>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {ACCOUNT_COLUMNS} FROM accounts ORDER BY code"
    ))?;
    let accounts = stmt
        .query_map([], to_account)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(accounts)
}

pub fn trial_balance(conn: &Connection, as_of: &str) -> Result<TrialBalance> {
    let mut stmt = conn.prepare(
        "SELECT a.id, a.code, a.name, a.type, SUM(l.debit), SUM(l.credit)
           FROM ledger_lines l
           JOIN journal_entries e ON e.id = l.entry_id
           JOIN accounts a ON a.id = l.account_id
          WHERE e.date <= ?
          GROUP BY a.id
          ORDER BY a.code",
    )?;
    let rows: Vec<TrialBalanceRow> = stmt
        .query_map([as_of], |r| {
            let net = r.get::<_, i64>(4)? - r.get::<_, i64>(5)?;
            Ok(TrialBalanceRow {
                account_id: r.get(0)?,
                code: r.get(1)?,
                name: r.get(2)?,
                kind: r.get(3)?,
                debit: net.max(0),
                credit: (-net).max(0),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .filter(|r| r.debit != 0 || r.credit != 0)
        .collect();
    Ok(TrialBalance {
        total_debit: rows.iter().map(|r| r.debit).sum(),
        total_credit: rows.iter().map(|r| r.credit).sum(),
        rows,
    })
}

/** JavaScript's `Number.isSafeInteger(x) && x > 0`. */
fn piastres(value: f64) -> Option<Piastres> {
    const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
    (value.fract() == 0.0 && value > 0.0 && value <= MAX_SAFE).then_some(value as i64)
}

/** A line's debit and credit in whole piastres, one of them zero; anything else is refused. */
fn amounts(line: &JournalLine) -> Result<(Piastres, Piastres)> {
    let has_debit = line.debit.is_some_and(|d| d != 0.0);
    let has_credit = line.credit.is_some_and(|c| c != 0.0);
    let amount = if has_debit { line.debit } else { line.credit };
    match (has_debit != has_credit)
        .then_some(amount)
        .flatten()
        .and_then(piastres)
    {
        Some(a) if has_debit => Ok((a, 0)),
        Some(a) => Ok((0, a)),
        None => refuse(
            "line_amount_invalid",
            "Each line needs either a debit or a credit, in whole piastres",
        ),
    }
}

fn validate_entry(
    conn: &Connection,
    input: &JournalEntryInput,
) -> Result<Vec<(Piastres, Piastres)>> {
    assert_iso_date(&input.date)?;
    if input.lines.len() < 2 {
        return refuse(
            "entry_needs_two_lines",
            "A journal entry needs at least two lines",
        );
    }
    let mut debits = 0;
    let mut credits = 0;
    let mut out = Vec::with_capacity(input.lines.len());
    for line in &input.lines {
        let (debit, credit) = amounts(line)?;
        debits += debit;
        credits += credit;
        let active: Option<i64> = conn
            .query_row(
                "SELECT active FROM accounts WHERE id = ?",
                [line.account_id],
                |r| r.get(0),
            )
            .optional()?;
        match active {
            None => {
                return refuse(
                    "account_not_found",
                    format!("No account with id {}", line.account_id),
                )
            }
            Some(a) if a != 1 => {
                return refuse(
                    "account_inactive",
                    format!("Account {} is inactive", line.account_id),
                )
            }
            _ => {}
        }
        out.push((debit, credit));
    }
    if debits != credits {
        return refuse(
            "entry_unbalanced",
            format!("Debits {debits} do not equal credits {credits}"),
        );
    }
    Ok(out)
}

pub fn post_journal_entry(conn: &Connection, input: &JournalEntryInput, kind: &str) -> Result<i64> {
    let amounts = validate_entry(conn, input)?;
    let lock: Option<String> = conn
        .query_row(
            "SELECT lock_date FROM business_settings WHERE id = 1",
            [],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    if let Some(lock) = lock.filter(|l| input.date.as_str() <= l.as_str()) {
        return refuse(
            "period_locked",
            format!(
                "The books are locked up to {lock}; nothing can be posted on {}",
                input.date
            ),
        );
    }
    conn.execute(
        "INSERT INTO journal_entries (date, memo, kind) VALUES (?, ?, ?)",
        params![input.date, input.memo.trim(), kind],
    )?;
    let entry_id = conn.last_insert_rowid();
    let mut insert = conn.prepare(
        "INSERT INTO ledger_lines (entry_id, account_id, debit, credit, memo, supplier_id, customer_id, foreign_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )?;
    for (line, (debit, credit)) in input.lines.iter().zip(amounts) {
        insert.execute(params![
            entry_id,
            line.account_id,
            debit,
            credit,
            line.memo.as_deref().unwrap_or(""),
            line.supplier_id,
            line.customer_id,
            line.foreign.map(|f| f as i64),
        ])?;
    }
    Ok(entry_id)
}

fn require_text(value: &str, code: &'static str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        let what = if code == "account_code_required" {
            "Code"
        } else {
            "Name"
        };
        return refuse(code, format!("{what} is required"));
    }
    Ok(trimmed.to_string())
}

fn assert_code_free(conn: &Connection, code: &str, except_id: Option<i64>) -> Result<()> {
    let taken: Option<i64> = conn
        .query_row("SELECT id FROM accounts WHERE code = ?", [code], |r| {
            r.get(0)
        })
        .optional()?;
    if taken.is_some_and(|id| Some(id) != except_id) {
        return refuse("account_code_taken", format!("Code {code} is already used"));
    }
    Ok(())
}

pub fn find_account(conn: &Connection, id: i64) -> Result<Account> {
    conn.query_row(
        &format!("SELECT {ACCOUNT_COLUMNS} FROM accounts WHERE id = ?"),
        [id],
        to_account,
    )
    .optional()?
    .ok_or_else(|| BusinessError::new("account_not_found", format!("No account with id {id}")))
}

fn assert_not_system(account: &Account) -> Result<()> {
    if account.role.is_some() {
        return refuse(
            "account_is_system",
            format!(
                "Account {} is posted to automatically by the app",
                account.code
            ),
        );
    }
    Ok(())
}

pub fn add_account(conn: &Connection, input: &NewAccount) -> Result<i64> {
    let code = require_text(&input.code, "account_code_required")?;
    let name = require_text(&input.name, "account_name_required")?;
    if !ACCOUNT_TYPES.contains(&input.kind.as_str()) {
        return refuse(
            "account_type_invalid",
            format!("Unknown type {}", input.kind),
        );
    }
    assert_code_free(conn, &code, None)?;
    conn.execute(
        "INSERT INTO accounts (code, name, type) VALUES (?, ?, ?)",
        params![code, name, input.kind],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn update_account(conn: &Connection, id: i64, changes: &AccountChanges) -> Result<()> {
    let account = find_account(conn, id)?;
    let code = match &changes.code {
        Some(c) => require_text(c, "account_code_required")?,
        None => account.code,
    };
    let name = match &changes.name {
        Some(n) => require_text(n, "account_name_required")?,
        None => account.name,
    };
    assert_code_free(conn, &code, Some(id))?;
    conn.execute(
        "UPDATE accounts SET code = ?, name = ? WHERE id = ?",
        params![code, name, id],
    )?;
    Ok(())
}

pub fn set_account_active(conn: &Connection, id: i64, active: bool) -> Result<()> {
    let account = find_account(conn, id)?;
    if !active {
        assert_not_system(&account)?;
    }
    conn.execute(
        "UPDATE accounts SET active = ? WHERE id = ?",
        params![active as i64, id],
    )?;
    Ok(())
}

pub fn delete_account(conn: &Connection, id: i64) -> Result<()> {
    let account = find_account(conn, id)?;
    assert_not_system(&account)?;
    let posted = conn
        .query_row(
            "SELECT 1 FROM ledger_lines WHERE account_id = ? LIMIT 1",
            [id],
            |_| Ok(()),
        )
        .optional()?;
    if posted.is_some() {
        return refuse(
            "account_has_postings",
            format!(
                "Account {} has postings; deactivate it instead",
                account.code
            ),
        );
    }
    conn.execute("DELETE FROM accounts WHERE id = ?", [id])?;
    Ok(())
}

/**
 * Posts the balances a shop brings in when it starts using the app. Whatever the lines leave
 * unbalanced goes to the opening balances equity account.
 */
pub fn post_opening_balances(conn: &Connection, date: &str, lines: &[JournalLine]) -> Result<i64> {
    let opening: i64 = conn
        .query_row(
            "SELECT id FROM accounts WHERE role = 'opening_balances'",
            [],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| {
            BusinessError::new(
                "account_not_found",
                "The opening balances account is missing",
            )
        })?;
    let difference: f64 = lines
        .iter()
        .map(|l| l.debit.unwrap_or(0.0) - l.credit.unwrap_or(0.0))
        .sum();
    let mut all = lines.to_vec();
    if difference > 0.0 {
        all.push(JournalLine {
            account_id: opening,
            credit: Some(difference),
            ..Default::default()
        });
    } else if difference < 0.0 {
        all.push(JournalLine {
            account_id: opening,
            debit: Some(-difference),
            ..Default::default()
        });
    }
    post_journal_entry(
        conn,
        &JournalEntryInput {
            date: date.to_string(),
            memo: "أرصدة افتتاحية".into(),
            lines: all,
        },
        "opening_balances",
    )
}
