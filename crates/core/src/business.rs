use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::customers::{self, Customer, CustomerChanges, CustomerInput};
use crate::error::{refuse, BusinessError, Result};
use crate::import::{self, ImportInput, ImportReport};
use crate::inventory::{
    self, ItemMovement, LowStockRow, StockCount, StockCountInput, WriteOff, WriteOffInput,
};
use crate::invoices::{
    self, CreditNote, CreditNoteInput, InvoiceLineInput, PostedCreditNote, PricedInvoice,
    SalesInvoice, SalesInvoiceInput, SalesInvoiceResult,
};
use crate::items::{
    self, BasisPoints, Item, ItemChanges, ItemInput, ItemsOptions, ScannedUnit, TaxCode,
    TaxRateInput,
};
use crate::ledger::Piastres;
use crate::ledger::{
    self, Account, AccountChanges, JournalEntryInput, JournalLine, NewAccount, TrialBalance,
};
use crate::migrations::{run_pending, LATEST_SCHEMA_VERSION};
use crate::money::{
    self, AccountLine, Expense, ExpenseInput, MoneyAccount, MoneyTransfer, MoneyTransferInput,
    PostedDocument, Reconciliation,
};
use crate::purchases::{
    self, DebitNote, DebitNoteInput, PostedNote, PricedPurchase, PurchaseInvoice,
    PurchaseInvoiceInput, PurchaseLineInput, PurchaseMoney, Supplier, SupplierAccount,
    SupplierChanges, SupplierInput,
};
use crate::quotations::{self, Quotation, QuotationInput, SavedQuotation};
use crate::returns::{self, ReturnInput, ReturnResult, SaleReturn};
use crate::sales::{
    self, CashSaleInput, Discount, HeldSale, HeldSaleInput, PricedSale, Receipt, SaleInput,
    SaleLineInput, SaleResult,
};
use crate::serials::{self, SerialHistory, SerialSettings};
use crate::settlements::{
    self, Aging, OpenDocument, PartyKind, PaymentInput, PaymentResult, Statement,
};
use crate::shifts::{self, CashInOut, CloseShiftInput, Shift, ZReport};
use crate::shipments::{self, ImportShipment, ImportShipmentInput};
use crate::stock::{self, OpeningStockLine, StockOnHand, Transfer, TransferInput, Warehouse};
use crate::users::{self, AuditEntry, Credentials, NewUser, User, UserChanges};
use crate::withholding::{self, WithholdingCategory, WithholdingRateInput, WithholdingReport};

pub const IN_MEMORY: &str = ":memory:";
/** Marks a SQLite file as a Manager+ business file ("MPLS"). */
const APPLICATION_ID: i64 = 0x4d50_4c53;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BusinessSettings {
    pub name: String,
    pub address: String,
    /** Egyptian Tax Authority registration number (9 digits), empty if none. */
    pub tax_registration_number: String,
    pub vat_registered: bool,
    /** Month the fiscal year starts, 1 = January. */
    pub fiscal_year_start_month: i64,
}

/** What the licence lets the books do. `read_only` names why when it is set. */
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenceLimits {
    pub read_only: Option<String>,
    pub users: Option<i64>,
}

/** The licence's mode as the books see it, for every screen's banner. */
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenceMode {
    pub read_only: Option<String>,
    pub users: Option<i64>,
    pub signed_in: usize,
}

/** Commands that still work read-only: backups, passwords, and sending to the ETA what was already posted. */
const READ_ONLY_ALLOWED: [&str; 4] = [
    "setBackupFolder",
    "changeOwnPassword",
    "resetPassword",
    "retryEta",
];

/** Who is signed in to a file, by sign-in, and what the licence allows; shared by every sign-in to it. */
#[derive(Default)]
struct Gate {
    limits: LicenceLimits,
    signed_in: HashMap<u64, i64>,
}

/** One open business file. Every sign-in to it shares its connection and gate. */
struct File {
    conn: Mutex<Connection>,
    /** Where the file lives; backups are named after it. */
    #[allow(dead_code)]
    path: String,
    gate: Mutex<Gate>,
}

static SESSIONS: AtomicU64 = AtomicU64::new(1);

/**
 * The one entry point to a business's books. Every business rule lives behind this facade;
 * screens only call its commands and queries.
 *
 * A `Business` acts for one signed-in user. `create` signs in the first manager; `open` returns a
 * signed-out business whose `sign_in` returns one that acts for that user. Every command checks
 * the user's role and is written to the audit log in the same transaction.
 */
pub struct Business {
    file: Arc<File>,
    user: Option<User>,
    session: u64,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic inside the core never leaves a transaction open (it rolls back on drop), so a poisoned lock is safe to reuse.
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn pragma_i64(conn: &Connection, name: &str) -> rusqlite::Result<i64> {
    conn.query_row(&format!("PRAGMA {name}"), [], |r| r.get(0))
}

fn remove_with_journal(path: &str) {
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{path}{suffix}"));
    }
}

/** "shop.mplus" at schema 18 → "shop قبل التحديث 18.mplus" beside it, numbered if that exists. */
fn before_upgrade_path(path: &str, version: i64) -> String {
    let base = strip_extension(path);
    let mut candidate = format!("{base} قبل التحديث {version}.mplus");
    let mut n = 2;
    while Path::new(&candidate).exists() {
        candidate = format!("{base} قبل التحديث {version} ({n}).mplus");
        n += 1;
    }
    candidate
}

fn strip_extension(path: &str) -> &str {
    match path.len().checked_sub(6) {
        Some(i) if path.is_char_boundary(i) && path[i..].eq_ignore_ascii_case(".mplus") => {
            &path[..i]
        }
        _ => path,
    }
}

/** A copy of the open database at `target`, which must not exist. */
pub fn copy_database(conn: &Connection, target: &str) -> Result<()> {
    if Path::new(target).exists() {
        return refuse("file_exists", format!("A file already exists at {target}"));
    }
    conn.execute("VACUUM INTO ?", [target])?;
    Ok(())
}

/** Puts a copy back over a file, dropping the file's journal so SQLite doesn't replay it on the copy. */
pub fn replace_file(backup: &str, target: &str) -> Result<()> {
    if !Path::new(backup).exists() {
        return refuse("file_not_found", format!("No file at {backup}"));
    }
    for suffix in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{target}{suffix}"));
    }
    std::fs::copy(backup, target).map_err(|e| BusinessError::new("internal", e.to_string()))?;
    Ok(())
}

pub(crate) fn to_western_digits(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '\u{0660}'..='\u{0669}' => char::from(b'0' + (c as u32 - 0x0660) as u8),
            _ => c,
        })
        .collect()
}

fn normalize_settings(settings: &BusinessSettings) -> Result<BusinessSettings> {
    let clean = BusinessSettings {
        name: settings.name.trim().to_string(),
        address: settings.address.trim().to_string(),
        tax_registration_number: to_western_digits(settings.tax_registration_number.trim()),
        vat_registered: settings.vat_registered,
        fiscal_year_start_month: settings.fiscal_year_start_month,
    };
    if clean.name.is_empty() {
        return refuse("name_required", "A business needs a name");
    }
    let trn = &clean.tax_registration_number;
    if !trn.is_empty() && !(trn.len() == 9 && trn.bytes().all(|b| b.is_ascii_digit())) {
        return refuse(
            "tax_registration_number_invalid",
            "Tax registration number must be 9 digits",
        );
    }
    if !(1..=12).contains(&clean.fiscal_year_start_month) {
        return refuse(
            "fiscal_year_start_month_invalid",
            "Fiscal year start month must be 1 to 12",
        );
    }
    Ok(clean)
}

/** The id an audit entry records for a command's result: the number it returned, or its `id`. */
fn id_of(result: &Value) -> Option<i64> {
    match result {
        Value::Number(n) => n.as_i64(),
        Value::Object(o) => o.get("id").and_then(Value::as_i64),
        _ => None,
    }
}

impl Business {
    fn new(file: Arc<File>, user: Option<User>) -> Business {
        let session = SESSIONS.fetch_add(1, Ordering::Relaxed);
        if let Some(u) = &user {
            lock(&file.gate).signed_in.insert(session, u.id);
        }
        Business {
            file,
            user,
            session,
        }
    }

    /** Create a new business file at `path` (or ":memory:"), with its first manager signed in. */
    pub fn create(
        path: &str,
        settings: &BusinessSettings,
        manager: &Credentials,
    ) -> Result<Business> {
        let clean = normalize_settings(settings)?;
        if path != IN_MEMORY && Path::new(path).exists() {
            return refuse("file_exists", format!("A file already exists at {path}"));
        }
        let made = (|| -> Result<(Connection, User)> {
            let mut conn = Connection::open(path)?;
            conn.execute_batch(&format!(
                "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA application_id = {APPLICATION_ID};"
            ))?;
            let tx = conn.transaction()?;
            run_pending(&tx, 0)?;
            tx.execute(
                "INSERT INTO business_settings
                   (id, name, address, tax_registration_number, vat_registered, fiscal_year_start_month)
                 VALUES (1, ?, ?, ?, ?, ?)",
                params![
                    clean.name,
                    clean.address,
                    clean.tax_registration_number,
                    clean.vat_registered as i64,
                    clean.fiscal_year_start_month
                ],
            )?;
            let id = users::add_user(
                &tx,
                &NewUser {
                    name: manager.name.clone(),
                    role: "manager".into(),
                    password: manager.password.clone(),
                },
            )?;
            let detail = serde_json::to_string(&clean).expect("settings serialize");
            users::write_audit(&tx, id, "createBusiness", None, &detail)?;
            let first = users::find_user(&tx, id)?;
            tx.commit()?;
            Ok((conn, first))
        })();
        match made {
            Ok((conn, first)) => Ok(Business::new(Arc::new(File::of(conn, path)), Some(first))),
            Err(error) => {
                // Never leave a half-made business file behind.
                if path != IN_MEMORY {
                    remove_with_journal(path);
                }
                Err(error)
            }
        }
    }

    /** Open an existing business file, signed out. A file from an older version is upgraded after a copy beside it. */
    pub fn open(path: &str) -> Result<Business> {
        if !Path::new(path).exists() {
            return refuse("file_not_found", format!("No file at {path}"));
        }
        let not_ours = || {
            BusinessError::new(
                "not_a_business_file",
                format!("{path} is not a Manager+ business file"),
            )
        };
        let mut conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(|_| not_ours())?;
        let checked = (|| -> Result<i64> {
            if pragma_i64(&conn, "application_id").map_err(|_| not_ours())? != APPLICATION_ID {
                return Err(not_ours());
            }
            let version = pragma_i64(&conn, "user_version").map_err(|_| not_ours())?;
            if version > LATEST_SCHEMA_VERSION {
                return refuse(
                    "made_by_newer_version",
                    format!("{path} was saved by a newer version of the app"),
                );
            }
            conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
                .map_err(|_| not_ours())?;
            Ok(version)
        })();
        let version = checked?;
        if version < LATEST_SCHEMA_VERSION {
            // A copy before upgrading, beside the file; if the upgrade fails the file goes back to it.
            let before = before_upgrade_path(path, version);
            let upgraded =
                copy_database(&conn, &before).and_then(|_| crate::migrations::migrate(&mut conn));
            if let Err(error) = upgraded {
                drop(conn);
                if Path::new(&before).exists() {
                    let _ = replace_file(&before, path);
                }
                eprintln!("{error}");
                return refuse(
                    "migration_failed",
                    format!("Upgrading {path} failed; it was put back as it was"),
                );
            }
        }
        Ok(Business::new(Arc::new(File::of(conn, path)), None))
    }

    /** Checks that a file is a business file this version can open, without changing it. */
    pub fn check(path: &str) -> Result<()> {
        if !Path::new(path).exists() {
            return refuse("file_not_found", format!("No file at {path}"));
        }
        let not_ours = || {
            BusinessError::new(
                "not_a_business_file",
                format!("{path} is not a Manager+ business file"),
            )
        };
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|_| not_ours())?;
        if pragma_i64(&conn, "application_id").map_err(|_| not_ours())? != APPLICATION_ID {
            return Err(not_ours());
        }
        if pragma_i64(&conn, "user_version").map_err(|_| not_ours())? > LATEST_SCHEMA_VERSION {
            return refuse(
                "made_by_newer_version",
                format!("{path} was saved by a newer version of the app"),
            );
        }
        Ok(())
    }

    /** Closes this handle. The file closes when its last sign-in does. */
    pub fn close(self) {
        self.sign_out();
    }

    /**
     * Returns this business acting for the user with these credentials. The licence's number of
     * users counts different people signed in at once; signing in again as yourself is not another.
     */
    pub fn sign_in(&self, name: &str, password: &str) -> Result<Business> {
        let user = users::authenticate(
            &self.conn(),
            &Credentials {
                name: name.into(),
                password: password.into(),
            },
        )?;
        {
            let gate = lock(&self.file.gate);
            let others: std::collections::HashSet<i64> = gate
                .signed_in
                .values()
                .copied()
                .filter(|id| *id != user.id)
                .collect();
            if let Some(limit) = gate.limits.users {
                if others.len() as i64 >= limit {
                    return refuse(
                        "licence_users_exceeded",
                        format!("The licence allows {limit} signed-in users"),
                    );
                }
            }
        }
        Ok(Business::new(self.file.clone(), Some(user)))
    }

    /** Ends this sign-in, so it no longer counts against the licence's users. */
    pub fn sign_out(&self) {
        lock(&self.file.gate).signed_in.remove(&self.session);
    }

    /** Applies the licence: read-only without a valid one, and how many users may be signed in. Set by the PC that holds the file. */
    pub fn set_licence_limits(&self, limits: LicenceLimits) {
        lock(&self.file.gate).limits = limits;
    }

    /** Whether the books are read-only and why, and the licensed and signed-in users. */
    pub fn licence_mode(&self) -> Result<LicenceMode> {
        self.read("licenceMode", |_| {
            let gate = lock(&self.file.gate);
            let people: std::collections::HashSet<i64> = gate.signed_in.values().copied().collect();
            Ok(LicenceMode {
                read_only: gate.limits.read_only.clone(),
                users: gate.limits.users,
                signed_in: people.len(),
            })
        })
    }

    /** The signed-in user, or None when signed out. */
    pub fn current_user(&self) -> Option<&User> {
        self.user.as_ref()
    }

    /** Shown before sign-in, so it needs none. */
    pub fn settings(&self) -> Result<BusinessSettings> {
        Ok(self.conn().query_row(
            "SELECT name, address, tax_registration_number, vat_registered, fiscal_year_start_month
               FROM business_settings WHERE id = 1",
            [],
            |r| {
                Ok(BusinessSettings {
                    name: r.get(0)?,
                    address: r.get(1)?,
                    tax_registration_number: r.get(2)?,
                    vat_registered: r.get::<_, i64>(3)? == 1,
                    fiscal_year_start_month: r.get(4)?,
                })
            },
        )?)
    }

    /** When the file's first record was made: the licence trial counts from the oldest file. */
    pub fn started_at(&self) -> Result<Option<String>> {
        Ok(self
            .conn()
            .query_row("SELECT MIN(at) FROM audit_log", [], |r| r.get(0))?)
    }

    fn conn(&self) -> MutexGuard<'_, Connection> {
        lock(&self.file.conn)
    }

    fn allow(&self, method: &str) -> Result<&User> {
        let Some(user) = &self.user else {
            return refuse("sign_in_required", "Sign in first");
        };
        if !users::roles_for(method).contains(&user.role.as_str()) {
            return refuse("not_allowed", format!("A {} may not {method}", user.role));
        }
        Ok(user)
    }

    /** A query: role check only. */
    fn read<T>(&self, method: &str, work: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        self.allow(method)?;
        work(&self.conn())
    }

    /** A command: role check, then the change and its audit entry in one transaction. */
    fn write<T: Serialize>(
        &self,
        method: &str,
        detail: Value,
        entity_id: Option<i64>,
        work: impl FnOnce(&Connection) -> Result<T>,
    ) -> Result<T> {
        let user = self.allow(method)?;
        if let Some(why) = &lock(&self.file.gate).limits.read_only {
            if !READ_ONLY_ALLOWED.contains(&method) {
                return refuse(
                    "read_only",
                    format!("Read-only ({why}): {method} is not allowed"),
                );
            }
        }
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let since = crate::stock::last_movement_id(&tx)?;
        let result = work(&tx)?;
        // Anything moved on a date before movements already there reprices the issues after it.
        crate::inventory::reprice_backdated(&tx, since)?;
        let entity =
            entity_id.or_else(|| id_of(&serde_json::to_value(&result).unwrap_or(Value::Null)));
        users::write_audit(
            &tx,
            user.id,
            method,
            entity,
            &crate::num::tidy(detail).to_string(),
        )?;
        tx.commit()?;
        Ok(result)
    }

    // Users

    pub fn users(&self) -> Result<Vec<User>> {
        self.read("users", users::list_users)
    }

    /** Adds a user and returns their id. */
    pub fn add_user(&self, user: &NewUser) -> Result<i64> {
        let detail = serde_json::json!({ "name": user.name, "role": user.role });
        self.write("addUser", detail, None, |c| users::add_user(c, user))
    }

    pub fn update_user(&self, id: i64, changes: &UserChanges) -> Result<()> {
        self.write(
            "updateUser",
            serde_json::to_value(changes).unwrap(),
            Some(id),
            |c| users::update_user(c, id, changes),
        )
    }

    pub fn reset_password(&self, id: i64, password: &str) -> Result<()> {
        self.write("resetPassword", Value::Null, Some(id), |c| {
            users::set_password(c, id, password)
        })
    }

    pub fn change_own_password(&self, current: &str, next: &str) -> Result<()> {
        let user = self.allow("changeOwnPassword")?.clone();
        users::authenticate(
            &self.conn(),
            &Credentials {
                name: user.name.clone(),
                password: current.into(),
            },
        )?;
        self.write("changeOwnPassword", Value::Null, Some(user.id), |c| {
            users::set_password(c, user.id, next)
        })
    }

    pub fn deactivate_user(&self, id: i64) -> Result<()> {
        self.write("deactivateUser", Value::Null, Some(id), |c| {
            users::set_user_active(c, id, false)
        })
    }

    pub fn reactivate_user(&self, id: i64) -> Result<()> {
        self.write("reactivateUser", Value::Null, Some(id), |c| {
            users::set_user_active(c, id, true)
        })
    }

    /** Who changed what, newest first. */
    pub fn audit_log(&self) -> Result<Vec<AuditEntry>> {
        self.read("auditLog", |c| users::read_audit_log(c, 500))
    }

    // Accounts and the ledger

    pub fn accounts(&self) -> Result<Vec<Account>> {
        self.read("accounts", ledger::list_accounts)
    }

    /** Posts a manual journal entry and returns its id. */
    pub fn post_journal_entry(&self, entry: &JournalEntryInput) -> Result<i64> {
        self.write(
            "postJournalEntry",
            serde_json::to_value(entry).unwrap(),
            None,
            |c| ledger::post_journal_entry(c, entry, "journal"),
        )
    }

    /** Adds an account to the chart and returns its id. */
    pub fn add_account(&self, account: &NewAccount) -> Result<i64> {
        self.write(
            "addAccount",
            serde_json::to_value(account).unwrap(),
            None,
            |c| ledger::add_account(c, account),
        )
    }

    /** Renames or renumbers an account. Its postings stay with it. */
    pub fn update_account(&self, id: i64, changes: &AccountChanges) -> Result<()> {
        self.write(
            "updateAccount",
            serde_json::to_value(changes).unwrap(),
            Some(id),
            |c| ledger::update_account(c, id, changes),
        )
    }

    pub fn deactivate_account(&self, id: i64) -> Result<()> {
        self.write("deactivateAccount", Value::Null, Some(id), |c| {
            ledger::set_account_active(c, id, false)
        })
    }

    pub fn reactivate_account(&self, id: i64) -> Result<()> {
        self.write("reactivateAccount", Value::Null, Some(id), |c| {
            ledger::set_account_active(c, id, true)
        })
    }

    /** Deletes an account that has never been posted to. */
    pub fn delete_account(&self, id: i64) -> Result<()> {
        self.write("deleteAccount", Value::Null, Some(id), |c| {
            ledger::delete_account(c, id)
        })
    }

    pub fn post_opening_balances(&self, date: &str, lines: &[JournalLine]) -> Result<i64> {
        let detail = serde_json::json!({ "date": date, "lines": lines });
        self.write("postOpeningBalances", detail, None, |c| {
            ledger::post_opening_balances(c, date, lines)
        })
    }

    pub fn trial_balance(&self, as_of: &str) -> Result<TrialBalance> {
        self.read("trialBalance", |c| ledger::trial_balance(c, as_of))
    }
}

// Tax codes, items, warehouses and stock
impl Business {
    pub fn tax_codes(&self) -> Result<Vec<TaxCode>> {
        self.read("taxCodes", items::list_tax_codes)
    }

    /** Adds a rate that applies from `from` onwards, for example when the law changes. */
    pub fn add_tax_rate(&self, tax_code_id: i64, rate: &TaxRateInput) -> Result<()> {
        self.write("addTaxRate", to_json(rate), Some(tax_code_id), |c| {
            items::add_tax_rate(c, tax_code_id, rate)
        })
    }

    /** The VAT rate (basis points) in force on a document date; zero when the business is not VAT-registered. */
    pub fn vat_rate(&self, tax_code_id: i64, date: &str) -> Result<BasisPoints> {
        self.allow("vatRate")?;
        let registered = self.settings()?.vat_registered;
        self.read("vatRate", |c| {
            items::vat_rate(c, tax_code_id, date, registered)
        })
    }

    /** Active items by Arabic name; `search` matches Arabic or English name, code or barcode. */
    pub fn items(&self, options: &ItemsOptions) -> Result<Vec<Item>> {
        self.read("items", |c| items::list_items(c, options))
    }

    pub fn add_item(&self, item: &ItemInput) -> Result<i64> {
        self.write("addItem", to_json(item), None, |c| items::add_item(c, item))
    }

    /** Changes an item; `pack: Some(None)` removes its pack unit. */
    pub fn update_item(&self, id: i64, changes: &ItemChanges) -> Result<()> {
        self.write("updateItem", to_json(changes), Some(id), |c| {
            items::update_item(c, id, changes)
        })
    }

    /** Hides an item from lists and the till; its history stays. */
    pub fn deactivate_item(&self, id: i64) -> Result<()> {
        self.write("deactivateItem", Value::Null, Some(id), |c| {
            items::set_item_active(c, id, false)
        })
    }

    pub fn reactivate_item(&self, id: i64) -> Result<()> {
        self.write("reactivateItem", Value::Null, Some(id), |c| {
            items::set_item_active(c, id, true)
        })
    }

    pub fn find_by_barcode(&self, barcode: &str) -> Result<Option<ScannedUnit>> {
        self.read("findByBarcode", |c| items::find_by_barcode(c, barcode))
    }

    pub fn warehouses(&self) -> Result<Vec<Warehouse>> {
        self.read("warehouses", stock::list_warehouses)
    }

    pub fn add_warehouse(&self, name: &str) -> Result<i64> {
        self.write("addWarehouse", json!({ "name": name }), None, |c| {
            stock::add_warehouse(c, name)
        })
    }

    pub fn rename_warehouse(&self, id: i64, name: &str) -> Result<()> {
        self.write("renameWarehouse", json!({ "name": name }), Some(id), |c| {
            stock::rename_warehouse(c, id, name)
        })
    }

    /** Stops a warehouse that holds no stock. */
    pub fn deactivate_warehouse(&self, id: i64) -> Result<()> {
        self.write("deactivateWarehouse", Value::Null, Some(id), |c| {
            stock::set_warehouse_active(c, id, false)
        })
    }

    pub fn reactivate_warehouse(&self, id: i64) -> Result<()> {
        self.write("reactivateWarehouse", Value::Null, Some(id), |c| {
            stock::set_warehouse_active(c, id, true)
        })
    }

    /** Quantity of an item in thousandths of its base unit: in total and per warehouse. */
    pub fn stock_on_hand(&self, item_id: i64) -> Result<StockOnHand> {
        self.read("stockOnHand", |c| stock::stock_on_hand(c, item_id))
    }

    /** Stock held on the day the business starts using the app, at its cost. */
    pub fn post_opening_stock(
        &self,
        date: &str,
        warehouse_id: i64,
        lines: &[OpeningStockLine],
    ) -> Result<i64> {
        let detail = json!({ "date": date, "warehouseId": warehouse_id, "lines": lines });
        self.write("postOpeningStock", detail, None, |c| {
            stock::post_opening_stock(c, date, warehouse_id, lines)
        })
    }

    /** Moves stock from one warehouse to another and returns the transfer's id. */
    pub fn transfer_stock(&self, transfer: &TransferInput) -> Result<i64> {
        self.write("transferStock", to_json(transfer), None, |c| {
            stock::transfer_stock(c, transfer)
        })
    }

    /** Transfers, newest first. */
    pub fn transfers(&self) -> Result<Vec<Transfer>> {
        self.read("transfers", stock::list_transfers)
    }

    /** Weighted average cost of one base unit of an item, in piastres, across all warehouses. */
    pub fn average_cost(&self, item_id: i64) -> Result<Piastres> {
        self.read("averageCost", |c| stock::average_cost(c, item_id))
    }

    /** Value at cost of all stock held of an item, in piastres. */
    pub fn stock_value(&self, item_id: i64) -> Result<Piastres> {
        self.read("stockValue", |c| stock::stock_value(c, item_id))
    }

    /** Turns serial tracking on or off for an item, with its warranty in months. */
    pub fn set_item_serials(&self, item_id: i64, settings: &SerialSettings) -> Result<()> {
        self.write("setItemSerials", to_json(settings), Some(item_id), |c| {
            serials::set_item_serials(c, item_id, settings)
        })
    }

    /** Where a serial number came from and went, and whether it is under warranty on `today`. */
    pub fn find_serial(&self, serial: &str, today: &str) -> Result<Vec<SerialHistory>> {
        self.read("findSerial", |c| serials::find_serial(c, serial, today))
    }

    /** Posts a stock count for one warehouse; differences go to Stock gain or Stock loss at average cost. */
    pub fn post_stock_count(&self, count: &StockCountInput) -> Result<i64> {
        let user_id = self.allow("postStockCount")?.id;
        self.write("postStockCount", to_json(count), None, |c| {
            inventory::post_stock_count(c, count, user_id)
        })
    }

    pub fn stock_counts(&self) -> Result<Vec<StockCount>> {
        self.read("stockCounts", inventory::list_stock_counts)
    }

    /** Damaged or expired stock taken out of a warehouse with a reason. */
    pub fn write_off_stock(&self, write_off: &WriteOffInput) -> Result<i64> {
        let user_id = self.allow("writeOffStock")?.id;
        self.write("writeOffStock", to_json(write_off), None, |c| {
            inventory::write_off_stock(c, write_off, user_id)
        })
    }

    pub fn write_offs(&self) -> Result<Vec<WriteOff>> {
        self.read("writeOffs", inventory::list_write_offs)
    }

    /** The quantity (base thousandths) below which the item is low on stock; None for none. */
    pub fn set_item_minimum(&self, item_id: i64, minimum: Option<f64>) -> Result<()> {
        self.write(
            "setItemMinimum",
            json!({ "minimum": minimum }),
            Some(item_id),
            |c| inventory::set_item_minimum(c, item_id, minimum),
        )
    }

    /** Items below their minimum, in total or in one warehouse. */
    pub fn low_stock(&self, warehouse_id: Option<i64>) -> Result<Vec<LowStockRow>> {
        self.read("lowStock", |c| inventory::low_stock(c, warehouse_id))
    }

    /** An item's stock movements with a running balance, in all warehouses or one. */
    pub fn item_movements(
        &self,
        item_id: i64,
        warehouse_id: Option<i64>,
    ) -> Result<Vec<ItemMovement>> {
        self.read("itemMovements", |c| {
            inventory::item_movements(c, item_id, warehouse_id)
        })
    }
}

// Suppliers, purchases and debit notes
impl Business {
    pub fn suppliers(&self) -> Result<Vec<Supplier>> {
        self.read("suppliers", purchases::list_suppliers)
    }

    pub fn add_supplier(&self, supplier: &SupplierInput) -> Result<i64> {
        self.write("addSupplier", to_json(supplier), None, |c| {
            purchases::add_supplier(c, supplier)
        })
    }

    pub fn update_supplier(&self, id: i64, changes: &SupplierChanges) -> Result<()> {
        self.write("updateSupplier", to_json(changes), Some(id), |c| {
            purchases::update_supplier(c, id, changes)
        })
    }

    pub fn deactivate_supplier(&self, id: i64) -> Result<()> {
        self.write("deactivateSupplier", Value::Null, Some(id), |c| {
            purchases::set_supplier_active(c, id, false)
        })
    }

    pub fn reactivate_supplier(&self, id: i64) -> Result<()> {
        self.write("reactivateSupplier", Value::Null, Some(id), |c| {
            purchases::set_supplier_active(c, id, true)
        })
    }

    /** What the business owes a supplier, in piastres. */
    pub fn supplier_balance(&self, id: i64) -> Result<Piastres> {
        self.read("supplierBalance", |c| purchases::supplier_balance(c, id))
    }

    /** What the business owes a supplier in their own currency, and in EGP as the books carry it. */
    pub fn supplier_account(&self, id: i64) -> Result<SupplierAccount> {
        self.read("supplierAccount", |c| purchases::supplier_account(c, id))
    }

    /** Net, VAT and total of purchase lines on a date, without posting anything. */
    pub fn price_purchase(
        &self,
        date: &str,
        lines: &[PurchaseLineInput],
        money: Option<&PurchaseMoney>,
    ) -> Result<PricedPurchase> {
        self.read("pricePurchase", |c| {
            Ok(purchases::price_purchase(c, date, lines, money)?.summary())
        })
    }

    /** Posts a supplier's invoice into a warehouse and returns its id. */
    pub fn post_purchase_invoice(&self, invoice: &PurchaseInvoiceInput) -> Result<i64> {
        let user_id = self.allow("postPurchaseInvoice")?.id;
        self.write("postPurchaseInvoice", to_json(invoice), None, |c| {
            purchases::post_purchase_invoice(c, invoice, user_id)
        })
    }

    /** Purchase invoices, newest first. */
    pub fn purchase_invoices(&self) -> Result<Vec<PurchaseInvoice>> {
        self.read("purchaseInvoices", purchases::list_purchase_invoices)
    }

    /** Sends goods back to a supplier against their invoice. */
    pub fn post_debit_note(&self, note: &DebitNoteInput) -> Result<PostedNote> {
        let user_id = self.allow("postDebitNote")?.id;
        self.write("postDebitNote", to_json(note), None, |c| {
            purchases::post_debit_note(c, note, user_id)
        })
    }

    pub fn debit_notes(&self) -> Result<Vec<DebitNote>> {
        self.read("debitNotes", purchases::list_debit_notes)
    }
}

// Customers
impl Business {
    pub fn customers(&self) -> Result<Vec<Customer>> {
        self.read("customers", customers::list_customers)
    }

    pub fn add_customer(&self, customer: &CustomerInput) -> Result<i64> {
        self.write("addCustomer", to_json(customer), None, |c| {
            customers::add_customer(c, customer)
        })
    }

    pub fn update_customer(&self, id: i64, changes: &CustomerChanges) -> Result<()> {
        self.write("updateCustomer", to_json(changes), Some(id), |c| {
            customers::update_customer(c, id, changes)
        })
    }

    /** A stopped customer stays in the books but cannot buy on credit. */
    pub fn deactivate_customer(&self, id: i64) -> Result<()> {
        self.write("deactivateCustomer", Value::Null, Some(id), |c| {
            customers::set_customer_active(c, id, false)
        })
    }

    pub fn reactivate_customer(&self, id: i64) -> Result<()> {
        self.write("reactivateCustomer", Value::Null, Some(id), |c| {
            customers::set_customer_active(c, id, true)
        })
    }

    /** What a customer owes the business, in piastres. */
    pub fn customer_balance(&self, id: i64) -> Result<Piastres> {
        self.read("customerBalance", |c| customers::customer_balance(c, id))
    }
}

// The till: shifts, sales, held carts and returns
impl Business {
    pub fn open_shift(&self, opening_float: f64) -> Result<i64> {
        let user_id = self.allow("openShift")?.id;
        self.write(
            "openShift",
            json!({ "openingFloat": opening_float }),
            None,
            |c| shifts::open_shift(c, user_id, opening_float),
        )
    }

    /** The signed-in user's open shift, if any. */
    pub fn current_shift(&self) -> Result<Option<Shift>> {
        let user_id = self.allow("currentShift")?.id;
        shifts::open_shift_of(&self.conn(), user_id)
    }

    pub fn cash_in_out(&self, movement: &CashInOut) -> Result<i64> {
        let user_id = self.allow("cashInOut")?.id;
        self.write("cashInOut", to_json(movement), None, |c| {
            shifts::cash_in_out(c, user_id, movement)
        })
    }

    pub fn close_shift(&self, close: &CloseShiftInput) -> Result<ZReport> {
        let user_id = self.allow("closeShift")?.id;
        self.write("closeShift", to_json(close), None, |c| {
            shifts::close_shift(c, user_id, close)
        })
    }

    pub fn z_report(&self, shift_id: i64) -> Result<ZReport> {
        self.read("zReport", |c| shifts::z_report(c, shift_id))
    }

    /** Shifts, newest first. */
    pub fn shifts(&self) -> Result<Vec<Shift>> {
        self.read("shifts", |c| shifts::list_shifts(c, 200))
    }

    /** Prices till lines at shelf prices (VAT-inclusive), without selling anything. */
    pub fn price_sale(
        &self,
        date: &str,
        lines: &[SaleLineInput],
        discount: Option<&Discount>,
    ) -> Result<PricedSale> {
        self.read("priceSale", |c| sales::price_sale(c, date, lines, discount))
    }

    pub fn hold_sale(&self, cart: &HeldSaleInput) -> Result<i64> {
        let user_id = self.allow("holdSale")?.id;
        self.write("holdSale", to_json(cart), None, |c| {
            sales::hold_sale(c, user_id, cart)
        })
    }

    pub fn held_sales(&self) -> Result<Vec<HeldSale>> {
        self.read("heldSales", sales::list_held_sales)
    }

    /** Brings a held cart back to the till. */
    pub fn recall_sale(&self, id: i64) -> Result<HeldSale> {
        self.write("recallSale", Value::Null, Some(id), |c| {
            sales::recall_sale(c, id)
        })
    }

    /** Sells for cash at the till; returns the receipt number and the change to give. */
    pub fn post_cash_sale(&self, sale: &CashSaleInput) -> Result<SaleResult> {
        let user_id = self.allow("postCashSale")?.id;
        self.write("postCashSale", to_json(sale), None, |c| {
            sales::post_cash_sale(c, sale, user_id)
        })
    }

    /** Sells at the till, paid by any mix of cash, card and wallet, with any rest on a customer's account. */
    pub fn post_sale(&self, sale: &SaleInput) -> Result<SaleResult> {
        let user_id = self.allow("postSale")?.id;
        self.write("postSale", without_password(to_json(sale)), None, |c| {
            sales::post_sale(c, sale, user_id)
        })
    }

    /** A receipt by its printed number, with what of each line was already returned. */
    pub fn find_receipt(&self, number: i64) -> Result<Receipt> {
        self.read("findReceipt", |c| sales::find_receipt(c, number))
    }

    /** Till receipts, newest first. */
    pub fn receipts(&self) -> Result<Vec<Receipt>> {
        self.read("receipts", |c| sales::list_receipts(c, 200))
    }

    /** Takes items back against their receipt, refunded in cash or to the receipt's customer. */
    pub fn return_sale(&self, input: &ReturnInput) -> Result<ReturnResult> {
        let user_id = self.allow("returnSale")?.id;
        self.write("returnSale", to_json(input), None, |c| {
            returns::return_sale(c, input, user_id)
        })
    }

    /** A return by its printed number. */
    pub fn find_return(&self, number: i64) -> Result<SaleReturn> {
        self.read("findReturn", |c| returns::find_return(c, number))
    }
}

// Sales invoices, credit notes and quotations
impl Business {
    /** Net, VAT and total of VAT-exclusive invoice lines on a date, without posting anything. */
    pub fn price_invoice(&self, date: &str, lines: &[InvoiceLineInput]) -> Result<PricedInvoice> {
        self.read("priceInvoice", |c| invoices::price_invoice(c, date, lines))
    }

    /** Posts a tax invoice to a customer's account. */
    pub fn post_sales_invoice(&self, invoice: &SalesInvoiceInput) -> Result<SalesInvoiceResult> {
        let user_id = self.allow("postSalesInvoice")?.id;
        self.write(
            "postSalesInvoice",
            without_password(to_json(invoice)),
            None,
            |c| {
                let posted = invoices::post_sales_invoice(c, invoice, user_id)?;
                invoices::queue_eta_document(c, "invoice", posted.id)?;
                Ok(posted)
            },
        )
    }

    /** Sales invoices, newest first. */
    pub fn sales_invoices(&self) -> Result<Vec<SalesInvoice>> {
        self.read("salesInvoices", |c| invoices::list_sales_invoices(c, 200))
    }

    /** A sales invoice by its printed number. */
    pub fn find_sales_invoice(&self, number: i64) -> Result<SalesInvoice> {
        self.read("findSalesInvoice", |c| {
            invoices::find_sales_invoice(c, number)
        })
    }

    /** Takes goods back against a sales invoice, credited to the customer's account. */
    pub fn post_credit_note(&self, note: &CreditNoteInput) -> Result<PostedCreditNote> {
        let user_id = self.allow("postCreditNote")?.id;
        self.write("postCreditNote", to_json(note), None, |c| {
            let posted = invoices::post_credit_note(c, note, user_id)?;
            invoices::queue_eta_document(c, "credit_note", posted.id)?;
            Ok(posted)
        })
    }

    /** A credit note by its printed number. */
    pub fn find_credit_note(&self, number: i64) -> Result<CreditNote> {
        self.read("findCreditNote", |c| invoices::find_credit_note(c, number))
    }

    /** The VAT-exclusive price of one unit for a customer's price level (retail with no customer). */
    pub fn list_price(
        &self,
        customer_id: Option<i64>,
        item_id: i64,
        unit: &str,
        date: &str,
    ) -> Result<Piastres> {
        self.read("listPrice", |c| {
            quotations::list_price(c, customer_id, item_id, unit, date)
        })
    }

    /** Saves a quotation for a customer; it posts nothing and moves no stock. */
    pub fn save_quotation(&self, quotation: &QuotationInput) -> Result<SavedQuotation> {
        let user_id = self.allow("saveQuotation")?.id;
        self.write("saveQuotation", to_json(quotation), None, |c| {
            quotations::save_quotation(c, quotation, user_id)
        })
    }

    /** Quotations, newest first, with their status (open, expired, converted) on `today`. */
    pub fn quotations(&self, today: &str) -> Result<Vec<Quotation>> {
        self.read("quotations", |c| quotations::list_quotations(c, today))
    }

    pub fn find_quotation(&self, number: i64, today: &str) -> Result<Quotation> {
        self.read("findQuotation", |c| {
            quotations::find_quotation(c, number, today)
        })
    }

    // Importing from spreadsheets

    /** A dry run of an import: every row is tried and nothing is saved. */
    pub fn check_import(&self, input: &ImportInput) -> Result<ImportReport> {
        self.read("importData", |c| import::import_data(c, input, true))
    }

    /** Imports items, opening stock and opening balances; refuses with nothing saved if any row fails. */
    pub fn import_data(&self, input: &ImportInput) -> Result<ImportReport> {
        if !self.check_import(input)?.problems.is_empty() {
            return refuse("import_invalid", "Some rows can't be imported");
        }
        let summary = json!({
            "date": input.date,
            "warehouseId": input.warehouse_id,
            "sheets": input.sheets.iter().map(|s| json!({ "name": s.name, "rows": s.rows.len() })).collect::<Vec<_>>(),
        });
        self.write("importData", summary, None, |c| {
            import::import_data(c, input, false)
        })
    }

    // Import shipments

    /** Spreads an import shipment's customs, freight and other costs into its items' cost. */
    pub fn post_import_shipment(&self, shipment: &ImportShipmentInput) -> Result<i64> {
        let user_id = self.allow("postImportShipment")?.id;
        self.write("postImportShipment", to_json(shipment), None, |c| {
            shipments::post_import_shipment(c, shipment, user_id)
        })
    }

    /** Import shipments, newest first, with each item's landed unit cost. */
    pub fn import_shipments(&self) -> Result<Vec<ImportShipment>> {
        self.read("importShipments", shipments::list_import_shipments)
    }

    // Money accounts, expenses, transfers, reconciliation and the lock date

    /** Cash, bank and wallet accounts with their balances on a date. */
    pub fn money_accounts(&self, as_of: &str) -> Result<Vec<MoneyAccount>> {
        self.read("moneyAccounts", |c| money::list_money_accounts(c, as_of))
    }

    pub fn record_expense(&self, expense: &ExpenseInput) -> Result<PostedDocument> {
        let user_id = self.allow("recordExpense")?.id;
        self.write("recordExpense", to_json(expense), None, |c| {
            money::record_expense(c, expense, user_id)
        })
    }

    /** Expenses, newest first. */
    pub fn expenses(&self) -> Result<Vec<Expense>> {
        self.read("expenses", money::list_expenses)
    }

    pub fn transfer_money(&self, transfer: &MoneyTransferInput) -> Result<PostedDocument> {
        let user_id = self.allow("transferMoney")?.id;
        self.write("transferMoney", to_json(transfer), None, |c| {
            money::transfer_money(c, transfer, user_id)
        })
    }

    /** Transfers between money accounts, newest first. */
    pub fn money_transfers(&self) -> Result<Vec<MoneyTransfer>> {
        self.read("moneyTransfers", money::list_money_transfers)
    }

    /** Every posting to an account between two dates, with its reconciled tick. */
    pub fn account_lines(&self, account_id: i64, from: &str, to: &str) -> Result<Vec<AccountLine>> {
        self.read("accountLines", |c| {
            money::account_lines(c, account_id, from, to)
        })
    }

    /** Ticks (or unticks) ledger lines of an account as on the bank statement. */
    pub fn set_cleared(&self, account_id: i64, line_ids: &[i64], cleared: bool) -> Result<()> {
        self.write(
            "setCleared",
            json!({ "lineIds": line_ids, "cleared": cleared }),
            Some(account_id),
            |c| money::set_cleared(c, account_id, line_ids, cleared),
        )
    }

    /** The account's balance and its ticked lines' balance against a statement balance. */
    pub fn reconciliation(&self, account_id: i64, statement: f64) -> Result<Reconciliation> {
        self.read("reconciliation", |c| {
            money::reconciliation(c, account_id, statement)
        })
    }

    pub fn lock_date(&self) -> Result<Option<String>> {
        self.read("lockDate", money::lock_date)
    }

    /** Nothing can be posted on or before this date; None unlocks. */
    pub fn set_lock_date(&self, date: Option<&str>) -> Result<()> {
        self.write("setLockDate", json!({ "date": date }), None, |c| {
            money::set_lock_date(c, date)
        })
    }

    /** Voids a journal entry, expense or transfer by posting its reverse on `date`; returns the reversing entry. */
    pub fn void_entry(&self, entry_id: i64, date: &str) -> Result<i64> {
        self.write("voidEntry", json!({ "date": date }), Some(entry_id), |c| {
            money::void_entry(c, entry_id, date)
        })
    }

    // Withholding tax

    pub fn withholding_categories(&self) -> Result<Vec<WithholdingCategory>> {
        self.read(
            "withholdingCategories",
            withholding::list_withholding_categories,
        )
    }

    /** Adds a withholding rate that applies from `from` onwards. */
    pub fn add_withholding_rate(
        &self,
        category_id: i64,
        rate: &WithholdingRateInput,
    ) -> Result<()> {
        self.write(
            "addWithholdingRate",
            to_json(rate),
            Some(category_id),
            |c| withholding::add_withholding_rate(c, category_id, rate),
        )
    }

    /** The withholding on `base` (the documents' value before VAT) at the category's rate on `date`. */
    pub fn withholding_tax(&self, category_id: i64, date: &str, base: f64) -> Result<Piastres> {
        self.read("withholdingTax", |c| {
            withholding::withholding_tax(c, category_id, date, base)
        })
    }

    /** Withholding taken on payments and receipts between two dates, for the quarterly form. */
    pub fn withholding_report(&self, from: &str, to: &str) -> Result<WithholdingReport> {
        self.read("withholdingReport", |c| {
            withholding::withholding_report(c, from, to)
        })
    }

    // Payments, statements and aging

    /** Money in from a customer, into a cash, bank or wallet account. */
    pub fn receive_customer_payment(&self, payment: &PaymentInput) -> Result<PaymentResult> {
        let user_id = self.allow("receiveCustomerPayment")?.id;
        self.write("receiveCustomerPayment", to_json(payment), None, |c| {
            settlements::record_payment(c, PartyKind::Customer, payment, user_id)
        })
    }

    /** Money out to a supplier, from a cash, bank or wallet account. */
    pub fn pay_supplier(&self, payment: &PaymentInput) -> Result<PaymentResult> {
        let user_id = self.allow("paySupplier")?.id;
        self.write("paySupplier", to_json(payment), None, |c| {
            settlements::record_payment(c, PartyKind::Supplier, payment, user_id)
        })
    }

    /** A party's documents with something not yet allocated, oldest first. */
    pub fn open_documents(&self, kind: PartyKind, party_id: i64) -> Result<Vec<OpenDocument>> {
        self.read("openDocuments", |c| {
            settlements::open_documents(c, kind, party_id)
        })
    }

    /** A customer's or supplier's statement of account between two dates. */
    pub fn statement(
        &self,
        kind: PartyKind,
        party_id: i64,
        from: &str,
        to: &str,
    ) -> Result<Statement> {
        self.read("statement", |c| {
            settlements::statement(c, kind, party_id, from, to)
        })
    }

    /** Aged receivables or payables on a date. */
    pub fn aging(&self, kind: PartyKind, as_of: &str) -> Result<Aging> {
        self.read("aging", |c| settlements::aging(c, kind, as_of))
    }
}

/** An audit entry names the manager who approved a credit limit, never their password. */
fn without_password(mut detail: Value) -> Value {
    if let Some(o) = detail.as_object_mut() {
        if let Some(approval) = o.remove("creditApproval") {
            if let Some(name) = approval.get("name") {
                o.insert("creditApprovedBy".into(), name.clone());
            }
        }
    }
    detail
}

fn to_json<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("inputs serialize")
}

impl std::fmt::Debug for Business {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Business")
            .field("user", &self.user)
            .field("session", &self.session)
            .finish()
    }
}

impl File {
    fn of(conn: Connection, path: &str) -> File {
        File {
            conn: Mutex::new(conn),
            path: path.to_string(),
            gate: Mutex::new(Gate::default()),
        }
    }
}
