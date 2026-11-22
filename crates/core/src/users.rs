use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use unicode_normalization::UnicodeNormalization;

use crate::error::{refuse, BusinessError, Result};

pub const ROLES: [&str; 4] = ["manager", "accountant", "cashier", "storekeeper"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct User {
    pub id: i64,
    pub name: String,
    pub role: String,
    pub active: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewUser {
    pub name: String,
    pub role: String,
    pub password: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UserChanges {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Credentials {
    pub name: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: i64,
    /** When, as an ISO timestamp in UTC. */
    pub at: String,
    pub user_id: i64,
    pub user_name: String,
    pub action: String,
    pub entity_id: Option<i64>,
    pub detail: String,
}

const MIN_PASSWORD: usize = 6;
/** scrypt N = 16384, r = 8, p = 1, 32 bytes: the same as the TypeScript core, so old files' passwords still work. */
const SCRYPT_LOG_N: u8 = 14;
const KEY_LENGTH: usize = 32;

fn scrypt(password: &str, salt: &[u8], length: usize) -> Vec<u8> {
    let normalized: String = password.nfc().collect();
    let params = scrypt::Params::new(SCRYPT_LOG_N, 8, 1, length).expect("valid scrypt parameters");
    let mut out = vec![0u8; length];
    scrypt::scrypt(normalized.as_bytes(), salt, &params, &mut out)
        .expect("valid scrypt output length");
    out
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok())
        .collect()
}

/** A salted scrypt hash, stored as "scrypt$<salt hex>$<hash hex>". */
fn hash_password(password: &str) -> String {
    let mut salt = [0u8; 16];
    getrandom::fill(&mut salt).expect("the OS random source works");
    format!(
        "scrypt${}${}",
        hex(&salt),
        hex(&scrypt(password, &salt, KEY_LENGTH))
    )
}

fn password_matches(password: &str, stored: &str) -> bool {
    let mut parts = stored.split('$');
    let (Some("scrypt"), Some(salt), Some(hash)) = (parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    let (Some(salt), Some(expected)) = (unhex(salt), unhex(hash)) else {
        return false;
    };
    if salt.is_empty() || expected.is_empty() {
        return false;
    }
    scrypt(password, &salt, expected.len())
        .ct_eq(&expected)
        .into()
}

fn clean_name(name: &str) -> Result<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return refuse("user_name_required", "A user needs a name");
    }
    Ok(trimmed.to_string())
}

fn assert_password(password: &str) -> Result<()> {
    if password.chars().count() < MIN_PASSWORD {
        return refuse(
            "password_too_short",
            format!("A password needs at least {MIN_PASSWORD} characters"),
        );
    }
    Ok(())
}

fn assert_role(role: &str) -> Result<()> {
    if !ROLES.contains(&role) {
        return refuse("role_invalid", format!("Unknown role {role}"));
    }
    Ok(())
}

fn to_user(r: &rusqlite::Row) -> rusqlite::Result<User> {
    Ok(User {
        id: r.get(0)?,
        name: r.get(1)?,
        role: r.get(2)?,
        active: r.get::<_, i64>(3)? == 1,
    })
}

pub fn list_users(conn: &Connection) -> Result<Vec<User>> {
    let mut stmt = conn.prepare("SELECT id, name, role, active FROM users ORDER BY id")?;
    let users = stmt
        .query_map([], to_user)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(users)
}

pub fn find_user(conn: &Connection, id: i64) -> Result<User> {
    conn.query_row(
        "SELECT id, name, role, active FROM users WHERE id = ?",
        [id],
        to_user,
    )
    .optional()?
    .ok_or_else(|| BusinessError::new("user_not_found", format!("No user with id {id}")))
}

fn assert_name_free(conn: &Connection, name: &str, except_id: Option<i64>) -> Result<()> {
    let owner: Option<i64> = conn
        .query_row("SELECT id FROM users WHERE name = ?", [name], |r| r.get(0))
        .optional()?;
    if owner.is_some_and(|id| Some(id) != except_id) {
        return refuse("user_name_taken", format!("A user called {name} exists"));
    }
    Ok(())
}

pub fn add_user(conn: &Connection, input: &NewUser) -> Result<i64> {
    let name = clean_name(&input.name)?;
    assert_role(&input.role)?;
    assert_password(&input.password)?;
    assert_name_free(conn, &name, None)?;
    conn.execute(
        "INSERT INTO users (name, role, password_hash) VALUES (?, ?, ?)",
        params![name, input.role, hash_password(&input.password)],
    )?;
    Ok(conn.last_insert_rowid())
}

fn assert_not_last_manager(conn: &Connection, user: &User) -> Result<()> {
    if user.role == "manager" && user.active {
        let others: i64 = conn.query_row(
            "SELECT COUNT(*) FROM users WHERE role = 'manager' AND active = 1 AND id <> ?",
            [user.id],
            |r| r.get(0),
        )?;
        if others == 0 {
            return refuse(
                "last_manager",
                "The business needs at least one active manager",
            );
        }
    }
    Ok(())
}

pub fn update_user(conn: &Connection, id: i64, changes: &UserChanges) -> Result<()> {
    let user = find_user(conn, id)?;
    let name = match &changes.name {
        Some(name) => clean_name(name)?,
        None => user.name.clone(),
    };
    let role = changes.role.clone().unwrap_or_else(|| user.role.clone());
    assert_role(&role)?;
    assert_name_free(conn, &name, Some(id))?;
    if role != "manager" {
        assert_not_last_manager(conn, &user)?;
    }
    conn.execute(
        "UPDATE users SET name = ?, role = ? WHERE id = ?",
        params![name, role, id],
    )?;
    Ok(())
}

pub fn set_user_active(conn: &Connection, id: i64, active: bool) -> Result<()> {
    let user = find_user(conn, id)?;
    if !active {
        assert_not_last_manager(conn, &user)?;
    }
    conn.execute(
        "UPDATE users SET active = ? WHERE id = ?",
        params![active as i64, id],
    )?;
    Ok(())
}

pub fn set_password(conn: &Connection, id: i64, password: &str) -> Result<()> {
    find_user(conn, id)?;
    assert_password(password)?;
    conn.execute(
        "UPDATE users SET password_hash = ? WHERE id = ?",
        params![hash_password(password), id],
    )?;
    Ok(())
}

/** The active user with this name and password; the same refusal whatever was wrong. */
pub fn authenticate(conn: &Connection, credentials: &Credentials) -> Result<User> {
    let row = conn
        .query_row(
            "SELECT id, name, role, active, password_hash FROM users WHERE name = ? AND active = 1",
            [credentials.name.trim()],
            |r| Ok((to_user(r)?, r.get::<_, String>(4)?)),
        )
        .optional()?;
    match row {
        Some((user, hash)) if password_matches(&credentials.password, &hash) => Ok(user),
        _ => refuse("sign_in_failed", "Wrong name or password"),
    }
}

/** Now as an ISO timestamp in UTC with milliseconds, as JavaScript's `toISOString` writes it. */
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn write_audit(
    conn: &Connection,
    user_id: i64,
    action: &str,
    entity_id: Option<i64>,
    detail: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO audit_log (at, user_id, action, entity_id, detail) VALUES (?, ?, ?, ?, ?)",
        params![now_iso(), user_id, action, entity_id, detail],
    )?;
    Ok(())
}

pub fn read_audit_log(conn: &Connection, limit: i64) -> Result<Vec<AuditEntry>> {
    let mut stmt = conn.prepare(
        "SELECT l.id, l.at, l.user_id, u.name, l.action, l.entity_id, l.detail
           FROM audit_log l JOIN users u ON u.id = l.user_id
          ORDER BY l.id DESC LIMIT ?",
    )?;
    let rows = stmt
        .query_map([limit], |r| {
            Ok(AuditEntry {
                id: r.get(0)?,
                at: r.get(1)?,
                user_id: r.get(2)?,
                user_name: r.get(3)?,
                action: r.get(4)?,
                entity_id: r.get(5)?,
                detail: r.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

const ALL: &[&str] = &ROLES;
const BOOKS: &[&str] = &["manager", "accountant"];
const STORE: &[&str] = &["manager", "storekeeper"];
const STORE_BOOKS: &[&str] = &["manager", "accountant", "storekeeper"];
const TILL: &[&str] = &["manager", "cashier"];
const TILL_BOOKS: &[&str] = &["manager", "accountant", "cashier"];
const MANAGER: &[&str] = &["manager"];

/** Which roles may call each facade method, as `PERMISSIONS` in `core/users.ts`. Anything not listed is manager-only. */
pub fn roles_for(method: &str) -> &'static [&'static str] {
    match method {
        // Cashiers pick the account for cash paid in or out of the drawer.
        "accounts" => TILL_BOOKS,
        "addAccount"
        | "updateAccount"
        | "deactivateAccount"
        | "reactivateAccount"
        | "deleteAccount"
        | "postJournalEntry"
        | "postOpeningBalances"
        | "trialBalance"
        | "addTaxRate"
        | "moneyAccounts"
        | "profitAndLoss"
        | "balanceSheet"
        | "generalLedger"
        | "journalEntry"
        | "salesByItem"
        | "salesByDay"
        | "salesByPaymentMethod"
        | "salesDocuments"
        | "stockAt"
        | "vatReturn"
        | "dashboard"
        | "recordExpense"
        | "expenses"
        | "transferMoney"
        | "moneyTransfers"
        | "accountLines"
        | "setCleared"
        | "reconciliation"
        | "setLockDate"
        | "voidEntry"
        | "addWithholdingRate"
        | "withholdingTax"
        | "withholdingReport"
        | "auditLog"
        | "postOpeningStock"
        | "etaSettings"
        | "etaDocuments"
        | "etaState"
        | "retryEta"
        | "deactivateSupplier"
        | "reactivateSupplier"
        | "supplierBalance"
        | "supplierAccount"
        | "postImportShipment"
        | "saveQuotation"
        | "quotations"
        | "findQuotation"
        | "importShipments"
        | "priceInvoice"
        | "postSalesInvoice"
        | "salesInvoices"
        | "findSalesInvoice"
        | "postCreditNote"
        | "findCreditNote"
        | "receiveCustomerPayment"
        | "paySupplier"
        | "openDocuments"
        | "statement"
        | "aging"
        | "updateCustomer"
        | "deactivateCustomer"
        | "reactivateCustomer" => BOOKS,
        "taxCodes"
        | "vatRate"
        | "withholdingCategories"
        | "lowStock"
        | "lockDate"
        | "items"
        | "findByBarcode"
        | "changeOwnPassword"
        | "warehouses"
        | "stockOnHand"
        | "etaReceiptQr"
        | "listPrice"
        | "findSerial" => ALL,
        "postStockCount"
        | "writeOffStock"
        | "setItemMinimum"
        | "addWarehouse"
        | "renameWarehouse"
        | "deactivateWarehouse"
        | "reactivateWarehouse"
        | "transferStock" => STORE,
        "stockCounts"
        | "writeOffs"
        | "itemMovements"
        | "addItem"
        | "updateItem"
        | "deactivateItem"
        | "reactivateItem"
        | "transfers"
        | "averageCost"
        | "suppliers"
        | "addSupplier"
        | "updateSupplier"
        | "stockValue"
        | "pricePurchase"
        | "postPurchaseInvoice"
        | "purchaseInvoices"
        | "postDebitNote"
        | "debitNotes"
        | "setItemSerials" => STORE_BOOKS,
        "openShift" | "currentShift" | "cashInOut" | "closeShift" | "postCashSale" | "postSale"
        | "holdSale" | "returnSale" | "heldSales" | "recallSale" => TILL,
        "zReport" | "licenceMode" | "shifts" | "priceSale" | "findReceipt" | "findReturn"
        | "customers" | "addCustomer" | "customerBalance" | "receipts" => TILL_BOOKS,
        _ => MANAGER,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hash_checks_its_own_password_only() {
        let stored = hash_password("كلمة سر قوية");
        assert!(stored.starts_with("scrypt$"));
        assert!(password_matches("كلمة سر قوية", &stored));
        assert!(!password_matches("كلمة سر", &stored));
        assert!(!password_matches("x", "plain"));
    }

    #[test]
    fn a_hash_made_by_the_typescript_core_still_works() {
        // Made by Node: crypto.scryptSync("كلمة سر قوية", salt 00..0f, 32, { N: 16384, r: 8, p: 1 }).
        let stored = "scrypt$000102030405060708090a0b0c0d0e0f$462359f66543017442144754b8db5180bd3507c701c6084d62dc1337a3778aa8";
        assert!(password_matches("كلمة سر قوية", stored));
        assert!(!password_matches("كلمة سر قويه", stored));
    }
}
