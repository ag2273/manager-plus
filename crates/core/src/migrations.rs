use rusqlite::{params, Connection, OptionalExtension};

use crate::chart::RETAIL_CHART_OF_ACCOUNTS;
use crate::error::Result;

/**
 * Forward-only schema migrations, the same as `core/migrations.ts`: each file is that migration's
 * SQL as the TypeScript one runs it, byte for byte, so files made by either app have the same
 * schema. Never edit a released migration; add a new one.
 */
struct Migration {
    version: i64,
    sql: &'static str,
    /** Rows the migration adds after its SQL. */
    data: Option<fn(&Connection) -> Result<()>>,
}

macro_rules! migration {
    ($version:literal, $file:literal) => {
        Migration {
            version: $version,
            sql: include_str!(concat!("../migrations/", $file, ".sql")),
            data: None,
        }
    };
    ($version:literal, $file:literal, $data:expr) => {
        Migration {
            version: $version,
            sql: include_str!(concat!("../migrations/", $file, ".sql")),
            data: Some($data),
        }
    };
}

const MIGRATIONS: &[Migration] = &[
    migration!(1, "0001"),
    migration!(2, "0002", starting_chart),
    migration!(3, "0003", tax_codes),
    migration!(4, "0004"),
    migration!(5, "0005", main_warehouse),
    migration!(6, "0006"),
    migration!(7, "0007"),
    migration!(8, "0008"),
    migration!(9, "0009"),
    migration!(10, "0010"),
    migration!(11, "0011"),
    migration!(12, "0012"),
    migration!(13, "0013"),
    migration!(14, "0014", exchange_accounts),
    migration!(15, "0015"),
    migration!(16, "0016"),
    migration!(17, "0017", withholding),
    migration!(18, "0018"),
    migration!(19, "0019"),
    migration!(20, "0020"),
    migration!(21, "0021"),
    migration!(22, "0022"),
    migration!(23, "0023"),
    migration!(24, "0024"),
];

pub const LATEST_SCHEMA_VERSION: i64 = 24;

/** Applies every migration newer than the file's schema version, all in one transaction. */
pub fn migrate(conn: &mut Connection) -> Result<()> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if current >= LATEST_SCHEMA_VERSION {
        return Ok(());
    }
    let tx = conn.transaction()?;
    run_pending(&tx, current)?;
    tx.commit()?;
    Ok(())
}

/** The same, inside a transaction the caller already holds. */
pub fn run_pending(conn: &Connection, current: i64) -> Result<()> {
    for m in MIGRATIONS.iter().filter(|m| m.version > current) {
        conn.execute_batch(m.sql)?;
        if let Some(data) = m.data {
            data(conn)?;
        }
    }
    conn.execute_batch(&format!("PRAGMA user_version = {LATEST_SCHEMA_VERSION}"))?;
    Ok(())
}

fn starting_chart(conn: &Connection) -> Result<()> {
    let mut insert =
        conn.prepare("INSERT INTO accounts (code, name, type, role) VALUES (?, ?, ?, ?)")?;
    for a in RETAIL_CHART_OF_ACCOUNTS {
        insert.execute(params![a.code, a.name, a.kind, a.role])?;
    }
    Ok(())
}

fn tax_codes(conn: &Connection) -> Result<()> {
    let code = |kind: &str, name: &str| -> Result<i64> {
        conn.execute(
            "INSERT INTO tax_codes (kind, name) VALUES (?, ?)",
            params![kind, name],
        )?;
        Ok(conn.last_insert_rowid())
    };
    let rate = |id: i64, from: &str, bp: i64| -> Result<()> {
        conn.execute(
            "INSERT INTO tax_rates (tax_code_id, effective_from, rate) VALUES (?, ?, ?)",
            params![id, from, bp],
        )?;
        Ok(())
    };
    let standard = code("standard", "ضريبة قيمة مضافة 14%")?;
    rate(standard, "2016-09-08", 1300)?;
    rate(standard, "2017-07-01", 1400)?;
    for (kind, name) in [("zero_rated", "خاضع بنسبة صفر"), ("exempt", "معفى")] {
        let id = code(kind, name)?;
        rate(id, "2016-09-08", 0)?;
    }
    Ok(())
}

fn main_warehouse(conn: &Connection) -> Result<()> {
    conn.execute(
        "INSERT INTO warehouses (name) VALUES (?)",
        ["المخزن الرئيسي"],
    )?;
    Ok(())
}

/** Adds the chart's accounts for these roles to a file made before they existed, on a free code. */
fn add_role_accounts(conn: &Connection, roles: &[&str]) -> Result<()> {
    for a in RETAIL_CHART_OF_ACCOUNTS
        .iter()
        .filter(|a| a.role.is_some_and(|r| roles.contains(&r)))
    {
        let exists = conn
            .query_row(
                "SELECT 1 FROM accounts WHERE role = ?",
                [a.role],
                |_| Ok(()),
            )
            .optional()?;
        if exists.is_some() {
            continue;
        }
        let mut code = a.code.to_string();
        while conn
            .query_row("SELECT 1 FROM accounts WHERE code = ?", [&code], |_| Ok(()))
            .optional()?
            .is_some()
        {
            code.push('1');
        }
        conn.execute(
            "INSERT INTO accounts (code, name, type, role) VALUES (?, ?, ?, ?)",
            params![code, a.name, a.kind, a.role],
        )?;
    }
    Ok(())
}

fn exchange_accounts(conn: &Connection) -> Result<()> {
    add_role_accounts(conn, &["exchange_gain", "exchange_loss"])
}

fn withholding(conn: &Connection) -> Result<()> {
    // The categories of the executive regulations; the accountant confirms them before release.
    for (name, bp) in [
        ("توريدات", 100),
        ("خدمات ومقاولات", 300),
        ("عمولات وسمسرة وأتعاب مهنية", 500),
    ] {
        conn.execute(
            "INSERT INTO withholding_categories (name) VALUES (?)",
            [name],
        )?;
        let id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO withholding_rates (category_id, effective_from, rate) VALUES (?, '2000-01-01', ?)",
            params![id, bp],
        )?;
    }
    add_role_accounts(conn, &["withholding_receivable", "withholding_payable"])
}
