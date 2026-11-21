import type Database from "better-sqlite3";
import { accessSync, constants, copyFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { BusinessError } from "./errors";

export type BackupFile = { path: string; name: string; at: string; size: number };
export type BackupStatus = { folder: string | null; lastBackupAt: string | null; backups: BackupFile[] };

/** How many backups a folder keeps for each business. */
export const KEEP_BACKUPS = 30;

/** "2026-11-21T08:05:09.123Z" → "2026-11-21 080509", sortable and safe in a file name. */
const stamp = (at: Date) => at.toISOString().slice(0, 19).replace("T", " ").replace(/:/g, "");
const prefix = (sourcePath: string) => `${basename(sourcePath, extname(sourcePath))} نسخة احتياطية `;
const PATTERN = / نسخة احتياطية (\d{4}-\d{2}-\d{2}) (\d{2})(\d{2})(\d{2})(?: (\d+))?\.mplus$/;

/** A consistent copy of the open database in one file, safe while it is in use (SQLite's VACUUM INTO). */
export function copyDatabase(db: Database.Database, target: string): void {
  if (existsSync(target)) throw new BusinessError("file_exists", `A file already exists at ${target}`);
  db.prepare("VACUUM INTO ?").run(target);
}

function assertFolder(folder: string): void {
  try {
    if (!statSync(folder).isDirectory()) throw new Error("not a folder");
    accessSync(folder, constants.W_OK);
  } catch {
    throw new BusinessError("backup_folder_invalid", `Can't write backups to ${folder}`);
  }
}

/** This business's backups in a folder, newest first. Other files there are left alone. */
export function listBackups(folder: string, sourcePath: string): BackupFile[] {
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return [];
  }
  const start = prefix(sourcePath);
  return names
    .filter((n) => n.startsWith(start) && PATTERN.test(n))
    .map((name) => {
      const [, date, h, m, s, n] = PATTERN.exec(name)!;
      const path = join(folder, name);
      return { path, name, at: `${date}T${h}:${m}:${s}Z`, size: statSync(path).size, n: Number(n ?? 1) };
    })
    .sort((a, b) => b.at.localeCompare(a.at) || b.n - a.n)
    .map((b) => ({ path: b.path, name: b.name, at: b.at, size: b.size }));
}

export function backupStatus(db: Database.Database, sourcePath: string): BackupStatus {
  const row = db.prepare("SELECT backup_folder AS folder, last_backup_at AS lastBackupAt FROM business_settings WHERE id = 1").get() as {
    folder: string | null;
    lastBackupAt: string | null;
  };
  return { ...row, backups: row.folder ? listBackups(row.folder, sourcePath) : [] };
}

export function setBackupFolder(db: Database.Database, folder: string | null): void {
  const clean = folder?.trim() || null;
  if (clean) assertFolder(clean);
  db.prepare("UPDATE business_settings SET backup_folder = ? WHERE id = 1").run(clean);
}

/** Backs the business up into its backup folder now and keeps the newest thirty. */
export function backupNow(db: Database.Database, sourcePath: string, at: Date): BackupFile {
  const { folder } = backupStatus(db, sourcePath);
  if (!folder) throw new BusinessError("backup_folder_required", "Choose a backup folder first");
  assertFolder(folder);
  let name = `${prefix(sourcePath)}${stamp(at)}.mplus`;
  // Two backups in the same second (a restore right after a backup) get a number.
  for (let n = 2; existsSync(join(folder, name)); n++) name = `${prefix(sourcePath)}${stamp(at)} ${n}.mplus`;
  const path = join(folder, name);
  copyDatabase(db, path);
  db.prepare("UPDATE business_settings SET last_backup_at = ? WHERE id = 1").run(at.toISOString());
  for (const old of listBackups(folder, sourcePath).slice(KEEP_BACKUPS)) rmSync(old.path, { force: true });
  return listBackups(folder, sourcePath).find((b) => b.path === path)!;
}

/** Whether the daily backup is due: a folder is set and the last backup was on another day. */
export function dailyBackupDue(db: Database.Database, sourcePath: string, now: Date): boolean {
  const { folder, lastBackupAt } = backupStatus(db, sourcePath);
  const day = (at: Date) => at.toLocaleDateString("en-CA");
  return folder !== null && (lastBackupAt === null || day(new Date(lastBackupAt)) !== day(now));
}

/** Puts a backup in place of a business file that is closed, dropping its write-ahead log. */
export function replaceFile(backup: string, target: string): void {
  if (!existsSync(backup)) throw new BusinessError("file_not_found", `No file at ${backup}`);
  for (const suffix of ["-wal", "-shm"]) rmSync(`${target}${suffix}`, { force: true });
  copyFileSync(backup, target);
}
