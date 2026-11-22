use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{refuse, BusinessError, Result};
use crate::ledger::{
    self, Account, AccountChanges, JournalEntryInput, JournalLine, NewAccount, TrialBalance,
};
use crate::migrations::{run_pending, LATEST_SCHEMA_VERSION};
use crate::users::{self, AuditEntry, Credentials, NewUser, User, UserChanges};

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

fn to_western_digits(text: &str) -> String {
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
        let result = work(&tx)?;
        // Stock movements dated before ones already there reprice the issues after them (#74).
        let entity =
            entity_id.or_else(|| id_of(&serde_json::to_value(&result).unwrap_or(Value::Null)));
        users::write_audit(&tx, user.id, method, entity, &detail.to_string())?;
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

    /** Nothing can be posted on or before this date. */
    pub fn lock_date(&self) -> Result<Option<String>> {
        self.read("lockDate", |c| {
            Ok(c.query_row(
                "SELECT lock_date FROM business_settings WHERE id = 1",
                [],
                |r| r.get(0),
            )
            .optional()?
            .flatten())
        })
    }

    pub fn set_lock_date(&self, date: Option<&str>) -> Result<()> {
        self.write(
            "setLockDate",
            serde_json::json!({ "date": date }),
            None,
            |c| {
                if let Some(d) = date {
                    crate::dates::assert_iso_date(d)?;
                }
                c.execute(
                    "UPDATE business_settings SET lock_date = ? WHERE id = 1",
                    [date],
                )?;
                Ok(())
            },
        )
    }
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
