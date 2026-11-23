//! The first-use setup (#97, note 10). A new business walks through its details, warehouses,
//! items and opening balances before it trades: selling or buying before the opening stock is in
//! leaves stock below zero and costs and profit wrong (#87). So sales and purchases stay closed
//! until the owner confirms the opening balances, or says the business is new with nothing to
//! bring forward. A file already in use when this came in counts as set up.

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::{refuse, Result};
use crate::users::now_iso;

/** The commands that trade, closed until the setup is finished. */
pub const NEEDS_SETUP: [&str; 7] = [
    "openShift",
    "holdSale",
    "postCashSale",
    "postSale",
    "postSalesInvoice",
    "postPurchaseInvoice",
    "postImportShipment",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SetupMode {
    /** Opening balances were entered and confirmed. */
    Opening,
    /** A new business with nothing to bring forward. */
    New,
    /** A file that was in use before the setup existed. */
    Existing,
}

impl SetupMode {
    fn as_str(self) -> &'static str {
        match self {
            SetupMode::Opening => "opening",
            SetupMode::New => "new",
            SetupMode::Existing => "existing",
        }
    }
}

/** How far the setup has come: the steps' state is read from the books, never kept apart. */
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupStatus {
    pub finished: bool,
    pub mode: Option<SetupMode>,
    pub finished_at: Option<String>,
    pub warehouses: i64,
    pub items: i64,
    /** Entries that brought balances in (stock, money, customers, suppliers), voids left out. */
    pub opening_entries: i64,
    pub users: i64,
}

fn mode_of(text: &str) -> SetupMode {
    match text {
        "opening" => SetupMode::Opening,
        "new" => SetupMode::New,
        _ => SetupMode::Existing,
    }
}

pub fn is_finished(conn: &Connection) -> Result<bool> {
    Ok(conn
        .query_row("SELECT 1 FROM setup WHERE id = 1", [], |_| Ok(()))
        .optional()?
        .is_some())
}

fn count(conn: &Connection, sql: &str) -> Result<i64> {
    Ok(conn.query_row(sql, [], |r| r.get(0))?)
}

pub fn status(conn: &Connection) -> Result<SetupStatus> {
    let done: Option<(String, String)> = conn
        .query_row(
            "SELECT mode, finished_at FROM setup WHERE id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    Ok(SetupStatus {
        finished: done.is_some(),
        mode: done.as_ref().map(|(m, _)| mode_of(m)),
        finished_at: done.map(|(_, at)| at),
        warehouses: count(conn, "SELECT COUNT(*) FROM warehouses WHERE active = 1")?,
        items: count(conn, "SELECT COUNT(*) FROM items WHERE active = 1")?,
        opening_entries: count(
            conn,
            "SELECT COUNT(DISTINCT e.id) FROM journal_entries e
               JOIN ledger_lines l ON l.entry_id = e.id
               JOIN accounts a ON a.id = l.account_id
              WHERE a.role = 'opening_balances' AND e.voided_by IS NULL
                AND NOT EXISTS (SELECT 1 FROM journal_entries v WHERE v.voided_by = e.id)",
        )?,
        users: count(conn, "SELECT COUNT(*) FROM users WHERE active = 1")?,
    })
}

/** Opens sales and purchases. Confirming opening balances needs some to have been entered. */
pub fn finish(conn: &Connection, mode: SetupMode) -> Result<SetupStatus> {
    if mode == SetupMode::Existing {
        return refuse(
            "setup_mode_unknown",
            "Choose opening balances or a new business",
        );
    }
    if is_finished(conn)? {
        return refuse("setup_finished", "The setup is already finished");
    }
    if mode == SetupMode::Opening && status(conn)?.opening_entries == 0 {
        return refuse(
            "opening_balances_missing",
            "No opening balances have been entered yet",
        );
    }
    conn.execute(
        "INSERT INTO setup (id, finished_at, mode) VALUES (1, ?, ?)",
        rusqlite::params![now_iso(), mode.as_str()],
    )?;
    status(conn)
}
