//! Backups: a consistent copy of the open file in a chosen folder, daily and on demand, keeping
//! the newest thirty; and restoring one in place of the file.

use std::path::Path;

use chrono::{DateTime, Local, SecondsFormat, Utc};
use rusqlite::Connection;
use serde::Serialize;

use crate::business::copy_database;
use crate::error::{refuse, BusinessError, Result};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BackupFile {
    pub path: String,
    pub name: String,
    /** When it was taken, as an ISO timestamp in UTC to the second. */
    pub at: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupStatus {
    pub folder: Option<String>,
    pub last_backup_at: Option<String>,
    pub backups: Vec<BackupFile>,
}

/** How many backups a folder keeps for each business. */
pub const KEEP_BACKUPS: usize = 30;

const MARK: &str = " نسخة احتياطية ";

/** 2026-11-21T08:05:09Z → "2026-11-21 080509", sortable and safe in a file name. */
pub(crate) fn stamp(at: DateTime<Utc>) -> String {
    at.format("%Y-%m-%d %H%M%S").to_string()
}

/** As JavaScript's `toISOString()` writes it: milliseconds and a Z. */
pub(crate) fn iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn file_stem(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn prefix(source: &str) -> String {
    format!("{}{MARK}", file_stem(source))
}

/** "2026-11-21 080509" or "2026-11-21 080509 2" → the time and the number. */
fn parse_stamp(rest: &str) -> Option<(String, i64)> {
    let (stamp, n) = match rest.split_once(' ').map(|(d, t)| (d, t.split_once(' '))) {
        Some((_, Some((_, n)))) => (&rest[..rest.len() - n.len() - 1], Some(n)),
        _ => (rest, None),
    };
    let b = stamp.as_bytes();
    let digits = |r: std::ops::Range<usize>| b[r].iter().all(u8::is_ascii_digit);
    if b.len() != 17
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b' '
        || !digits(0..4)
        || !digits(5..7)
        || !digits(8..10)
        || !digits(11..17)
    {
        return None;
    }
    let n = match n {
        None => 1,
        Some(n) if !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit()) => n.parse().ok()?,
        Some(_) => return None,
    };
    let at = format!(
        "{}T{}:{}:{}Z",
        &stamp[..10],
        &stamp[11..13],
        &stamp[13..15],
        &stamp[15..17]
    );
    Some((at, n))
}

fn assert_folder(folder: &str) -> Result<()> {
    let bad = || {
        BusinessError::new(
            "backup_folder_invalid",
            format!("Can't write backups to {folder}"),
        )
    };
    if !Path::new(folder).is_dir() {
        return Err(bad());
    }
    let probe = Path::new(folder).join(format!(".mplus-write-check-{}", std::process::id()));
    std::fs::write(&probe, b"").map_err(|_| bad())?;
    let _ = std::fs::remove_file(probe);
    Ok(())
}

/** This business's backups in a folder, newest first. Other files there are left alone. */
pub fn list_backups(folder: &str, source: &str) -> Vec<BackupFile> {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return Vec::new();
    };
    let start = prefix(source);
    let mut found: Vec<(BackupFile, i64)> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let rest = name.strip_prefix(&start)?.strip_suffix(".mplus")?;
            let (at, n) = parse_stamp(rest)?;
            let size = entry.metadata().ok()?.len();
            let path = entry.path().to_string_lossy().into_owned();
            Some((
                BackupFile {
                    path,
                    name,
                    at,
                    size,
                },
                n,
            ))
        })
        .collect();
    found.sort_by(|(a, an), (b, bn)| b.at.cmp(&a.at).then(bn.cmp(an)));
    found.into_iter().map(|(b, _)| b).collect()
}

pub fn backup_status(conn: &Connection, source: &str) -> Result<BackupStatus> {
    let (folder, last_backup_at): (Option<String>, Option<String>) = conn.query_row(
        "SELECT backup_folder, last_backup_at FROM business_settings WHERE id = 1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let backups = folder
        .as_deref()
        .map_or_else(Vec::new, |f| list_backups(f, source));
    Ok(BackupStatus {
        folder,
        last_backup_at,
        backups,
    })
}

pub fn set_backup_folder(conn: &Connection, folder: Option<&str>) -> Result<()> {
    let clean = folder.map(str::trim).filter(|f| !f.is_empty());
    if let Some(f) = clean {
        assert_folder(f)?;
    }
    conn.execute(
        "UPDATE business_settings SET backup_folder = ? WHERE id = 1",
        [clean],
    )?;
    Ok(())
}

/** Backs the business up into its backup folder now and keeps the newest thirty. */
pub fn backup_now(conn: &Connection, source: &str, at: DateTime<Utc>) -> Result<BackupFile> {
    let Some(folder) = backup_status(conn, source)?.folder else {
        return refuse("backup_folder_required", "Choose a backup folder first");
    };
    assert_folder(&folder)?;
    let base = format!("{}{}", prefix(source), stamp(at));
    let mut name = format!("{base}.mplus");
    // Two backups in the same second (a restore right after a backup) get a number.
    let mut n = 2;
    while Path::new(&folder).join(&name).exists() {
        name = format!("{base} {n}.mplus");
        n += 1;
    }
    let path = Path::new(&folder)
        .join(&name)
        .to_string_lossy()
        .into_owned();
    copy_database(conn, &path)?;
    conn.execute(
        "UPDATE business_settings SET last_backup_at = ? WHERE id = 1",
        [iso(at)],
    )?;
    for old in list_backups(&folder, source).into_iter().skip(KEEP_BACKUPS) {
        let _ = std::fs::remove_file(old.path);
    }
    list_backups(&folder, source)
        .into_iter()
        .find(|b| b.path == path)
        .ok_or_else(|| BusinessError::new("internal", format!("The backup at {path} is missing")))
}

/** Whether the daily backup is due: a folder is set and the last backup was on another day here. */
pub fn daily_backup_due(conn: &Connection, source: &str, now: DateTime<Utc>) -> Result<bool> {
    let status = backup_status(conn, source)?;
    let day = |at: DateTime<Utc>| at.with_timezone(&Local).date_naive();
    let last = status
        .last_backup_at
        .as_deref()
        .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
        .map(|at| at.with_timezone(&Utc));
    Ok(status.folder.is_some() && last.is_none_or(|last| day(last) != day(now)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamps_read_back() {
        assert_eq!(
            parse_stamp("2026-11-21 080509"),
            Some(("2026-11-21T08:05:09Z".into(), 1))
        );
        assert_eq!(
            parse_stamp("2026-11-21 080509 3"),
            Some(("2026-11-21T08:05:09Z".into(), 3))
        );
        assert_eq!(parse_stamp("2026-11-21 0805"), None);
        assert_eq!(parse_stamp("2026-11-21 080509 x"), None);
        assert_eq!(parse_stamp("notes"), None);
    }
}
