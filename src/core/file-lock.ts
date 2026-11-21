import { readFileSync, rmSync, writeFileSync } from "node:fs";

/** Who has a business file open: written next to it as "<file>.lock" and refreshed while open. */
export type LockInfo = { host: string; pid: number; at: string };
/** A lock older than this is from a PC that closed without tidying up (a crash, a power cut). */
export const STALE_AFTER_MS = 15 * 60 * 1000;

const lockPath = (path: string) => `${path}.lock`;

function readLock(path: string): LockInfo | null {
  try {
    const lock = JSON.parse(readFileSync(lockPath(path), "utf8")) as Partial<LockInfo>;
    return typeof lock.host === "string" && typeof lock.pid === "number" && typeof lock.at === "string" ? (lock as LockInfo) : null;
  } catch {
    return null;
  }
}

/** The sync service a path sits under (Dropbox, OneDrive, Google Drive), or null. */
export function syncFolder(path: string): string | null {
  const parts = path.split(/[\\/]+/).map((p) => p.toLowerCase());
  if (parts.some((p) => p === "dropbox" || p.startsWith("dropbox ("))) return "Dropbox";
  if (parts.some((p) => p === "onedrive" || p.startsWith("onedrive -") || p.startsWith("onedrive-"))) return "OneDrive";
  if (parts.some((p) => p === "google drive" || p === "my drive" || p === "googledrive" || p === "drivefs")) return "Google Drive";
  return null;
}

/**
 * Takes the lock on a business file for this PC. Returns who else had it open, when another PC's
 * lock is still fresh; this PC's own lock, or a stale one, is simply taken over.
 */
export function takeLock(path: string, me: { host: string; pid: number }, now: Date): LockInfo | null {
  const existing = readLock(path);
  const elsewhere = existing && existing.host !== me.host && now.getTime() - Date.parse(existing.at) < STALE_AFTER_MS ? existing : null;
  writeFileSync(lockPath(path), JSON.stringify({ ...me, at: now.toISOString() }));
  return elsewhere;
}

/** Keeps the lock fresh while the file is open. */
export function refreshLock(path: string, me: { host: string; pid: number }, now: Date): void {
  const existing = readLock(path);
  if (!existing || (existing.host === me.host && existing.pid === me.pid)) writeFileSync(lockPath(path), JSON.stringify({ ...me, at: now.toISOString() }));
}

/** Removes the lock when closing, if it is still this PC's. */
export function releaseLock(path: string, me: { host: string; pid: number }): void {
  const existing = readLock(path);
  if (existing && existing.host === me.host && existing.pid === me.pid) rmSync(lockPath(path), { force: true });
}
