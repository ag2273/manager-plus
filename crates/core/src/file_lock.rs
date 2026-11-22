//! Who has a business file open: written next to it as "<file>.lock" and refreshed while open.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::backup::iso;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LockInfo {
    pub host: String,
    pub pid: u32,
    pub at: String,
}

/** This PC and process, as a lock names them. */
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Me {
    pub host: String,
    pub pid: u32,
}

/** A lock older than this is from a PC that closed without tidying up (a crash, a power cut). */
pub const STALE_AFTER_MINUTES: i64 = 15;

fn lock_path(path: &str) -> String {
    format!("{path}.lock")
}

fn read_lock(path: &str) -> Option<LockInfo> {
    serde_json::from_str(&std::fs::read_to_string(lock_path(path)).ok()?).ok()
}

fn write_lock(path: &str, me: &Me, now: DateTime<Utc>) {
    let lock = LockInfo {
        host: me.host.clone(),
        pid: me.pid,
        at: iso(now),
    };
    let _ = std::fs::write(
        lock_path(path),
        serde_json::to_string(&lock).expect("a lock serializes"),
    );
}

/** The sync service a path sits under (Dropbox, OneDrive, Google Drive), or None. */
pub fn sync_folder(path: &str) -> Option<&'static str> {
    let parts: Vec<String> = path
        .split(['\\', '/'])
        .filter(|p| !p.is_empty())
        .map(str::to_lowercase)
        .collect();
    let any = |f: &dyn Fn(&str) -> bool| parts.iter().any(|p| f(p));
    if any(&|p| p == "dropbox" || p.starts_with("dropbox (")) {
        return Some("Dropbox");
    }
    if any(&|p| p == "onedrive" || p.starts_with("onedrive -") || p.starts_with("onedrive-")) {
        return Some("OneDrive");
    }
    if any(&|p| matches!(p, "google drive" | "my drive" | "googledrive" | "drivefs")) {
        return Some("Google Drive");
    }
    None
}

/**
 * Takes the lock on a business file for this PC. Returns who else had it open, when another PC's
 * lock is still fresh; this PC's own lock, or a stale one, is simply taken over.
 */
pub fn take_lock(path: &str, me: &Me, now: DateTime<Utc>) -> Option<LockInfo> {
    let elsewhere = read_lock(path).filter(|lock| {
        lock.host != me.host
            && DateTime::parse_from_rfc3339(&lock.at)
                .is_ok_and(|at| (now - at.with_timezone(&Utc)).num_minutes() < STALE_AFTER_MINUTES)
    });
    write_lock(path, me, now);
    elsewhere
}

/** Keeps the lock fresh while the file is open. */
pub fn refresh_lock(path: &str, me: &Me, now: DateTime<Utc>) {
    match read_lock(path) {
        Some(lock) if lock.host != me.host || lock.pid != me.pid => {}
        _ => write_lock(path, me, now),
    }
}

/** Removes the lock when closing, if it is still this PC's. */
pub fn release_lock(path: &str, me: &Me) {
    if read_lock(path).is_some_and(|lock| lock.host == me.host && lock.pid == me.pid) {
        let _ = std::fs::remove_file(lock_path(path));
    }
}
