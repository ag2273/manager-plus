/** The slice of Cloudflare D1 the server uses, so tests can run it on SQLite. */
export type D1Statement = {
  bind(...values: unknown[]): D1Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
};
export type D1Like = { prepare(sql: string): D1Statement; batch(statements: D1Statement[]): Promise<unknown[]> };

/** What the app verifies; the same shape as the app's `LicencePayload`. */
export type LicencePayload = { licenceId: string; company: string; machine: string; users: number; supportUntil: string; issuedAt: string };
export type LicenceFile = { payload: string; signature: string };

/** Why an activation is refused, as the codes the app shows in its language. */
export type Refusal = "licence_key_invalid" | "licence_moves_exhausted" | "licence_revoked";
export class Refused extends Error {
  constructor(readonly code: Refusal | "invalid_input" | "not_found") {
    super(code);
  }
}

export const MOVES_PER_YEAR = 2;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const KEY_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

/** A new key, XXXX-XXXX-XXXX-XXXX, from letters and digits that can't be misread for each other. */
export function newKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const chars = [...bytes].map((b) => KEY_ALPHABET[b % KEY_ALPHABET.length]).join("");
  return chars.match(/.{4}/g)!.join("-");
}

const normalizeKey = (key: string) => key.trim().toUpperCase().replace(/\s+/g, "");

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text.replace(/-----[^-]+-----|\s/g, "")), (c) => c.charCodeAt(0));

/** Signs licence files with the Ed25519 private key kept as a Worker secret (PKCS#8, base64 or PEM). */
export async function signer(privateKey: string): Promise<(payload: LicencePayload) => Promise<LicenceFile>> {
  const key = await crypto.subtle.importKey("pkcs8", fromBase64(privateKey), { name: "Ed25519" }, false, ["sign"]);
  return async (payload) => {
    const data = new TextEncoder().encode(JSON.stringify(payload));
    const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, data));
    return { payload: base64(data), signature: base64(signature) };
  };
}

type LicenceRow = { id: number; company: string; users: number; support_until: string; revoked_at: string | null };
type ActivationRow = { id: number; machine: string };

/**
 * Activates a key on a PC and returns its signed licence file. The same PC again gets a fresh
 * file; another PC takes the licence over if a move is left (two in any 12 months), ending the old one.
 */
export async function activate(
  db: D1Like,
  sign: (payload: LicencePayload) => Promise<LicenceFile>,
  input: { key: string; machine: string; appVersion: string },
  now: Date,
): Promise<LicenceFile> {
  const machine = input.machine.trim();
  if (!/^[0-9a-f]{16,64}$/.test(machine)) throw new Refused("invalid_input");
  const licence = await db
    .prepare("SELECT id, company, users, support_until, revoked_at FROM licences WHERE key_hash = ?")
    .bind(await sha256(normalizeKey(input.key)))
    .first<LicenceRow>();
  if (!licence) throw new Refused("licence_key_invalid");
  if (licence.revoked_at) throw new Refused("licence_revoked");

  const at = now.toISOString();
  const current = await db
    .prepare("SELECT id, machine FROM activations WHERE licence_id = ? AND ended_at IS NULL")
    .bind(licence.id)
    .first<ActivationRow>();
  const appVersion = input.appVersion.slice(0, 32);
  if (!current) {
    await db
      .prepare("INSERT INTO activations (licence_id, machine, app_version, activated_at) VALUES (?, ?, ?, ?)")
      .bind(licence.id, machine, appVersion, at)
      .run();
  } else if (current.machine !== machine) {
    const since = new Date(now.getTime() - YEAR_MS).toISOString();
    const moves = await db
      .prepare("SELECT COUNT(*) AS n FROM activations WHERE licence_id = ? AND end_reason = 'move' AND ended_at >= ?")
      .bind(licence.id, since)
      .first<{ n: number }>();
    if ((moves?.n ?? 0) >= MOVES_PER_YEAR) throw new Refused("licence_moves_exhausted");
    await db.batch([
      db.prepare("UPDATE activations SET ended_at = ?, end_reason = 'move' WHERE id = ?").bind(at, current.id),
      db
        .prepare("INSERT INTO activations (licence_id, machine, app_version, activated_at) VALUES (?, ?, ?, ?)")
        .bind(licence.id, machine, appVersion, at),
    ]);
  } else {
    await db.prepare("UPDATE activations SET app_version = ? WHERE id = ?").bind(appVersion, current.id).run();
  }
  return sign({
    licenceId: `L-${licence.id}`,
    company: licence.company,
    machine,
    users: licence.users,
    supportUntil: licence.support_until,
    issuedAt: at,
  });
}

/** Counts a request against a bucket's limit per window; false once the limit is reached. */
export async function withinLimit(db: D1Like, bucket: string, limit: number, windowMs: number, now: Date): Promise<boolean> {
  const window = Math.floor(now.getTime() / windowMs) * windowMs;
  const row = await db
    .prepare("SELECT window_start, count FROM rate_limits WHERE bucket = ?")
    .bind(bucket)
    .first<{ window_start: number; count: number }>();
  if (!row || row.window_start !== window) {
    await db
      .prepare(
        "INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1) ON CONFLICT (bucket) DO UPDATE SET window_start = ?, count = 1",
      )
      .bind(bucket, window, window)
      .run();
    return true;
  }
  if (row.count >= limit) return false;
  await db.prepare("UPDATE rate_limits SET count = count + 1 WHERE bucket = ?").bind(bucket).run();
  return true;
}

// Admin

export type LicenceSummary = {
  id: number;
  company: string;
  keyHint: string;
  users: number;
  supportUntil: string;
  notes: string;
  createdAt: string;
  revokedAt: string | null;
  machine: string | null;
  activatedAt: string | null;
  movesUsed: number;
  paid: number;
  activations: { machine: string; activatedAt: string; endedAt: string | null; endReason: string | null; appVersion: string }[];
  payments: { paidOn: string; amount: number; note: string }[];
};

const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));

/** Every licence with its PC, moves used in the last 12 months, payments and history; newest first. */
export async function listLicences(db: D1Like, now: Date): Promise<LicenceSummary[]> {
  const since = new Date(now.getTime() - YEAR_MS).toISOString();
  const licences = (
    await db
      .prepare("SELECT id, company, key_hint, users, support_until, notes, created_at, revoked_at FROM licences ORDER BY id DESC")
      .all<{
        id: number;
        company: string;
        key_hint: string;
        users: number;
        support_until: string;
        notes: string;
        created_at: string;
        revoked_at: string | null;
      }>()
  ).results;
  const activations = (
    await db
      .prepare("SELECT licence_id, machine, activated_at, ended_at, end_reason, app_version FROM activations ORDER BY id DESC")
      .all<{ licence_id: number; machine: string; activated_at: string; ended_at: string | null; end_reason: string | null; app_version: string }>()
  ).results;
  const payments = (
    await db
      .prepare("SELECT licence_id, paid_on, amount, note FROM payments ORDER BY paid_on DESC, id DESC")
      .all<{ licence_id: number; paid_on: string; amount: number; note: string }>()
  ).results;
  return licences.map((l) => {
    const mine = activations.filter((a) => a.licence_id === l.id);
    const current = mine.find((a) => a.ended_at === null) ?? null;
    const paid = payments.filter((p) => p.licence_id === l.id);
    return {
      id: l.id,
      company: l.company,
      keyHint: l.key_hint,
      users: l.users,
      supportUntil: l.support_until,
      notes: l.notes,
      createdAt: l.created_at,
      revokedAt: l.revoked_at,
      machine: current?.machine ?? null,
      activatedAt: current?.activated_at ?? null,
      movesUsed: mine.filter((a) => a.end_reason === "move" && a.ended_at! >= since).length,
      paid: paid.reduce((t, p) => t + p.amount, 0),
      activations: mine.map((a) => ({
        machine: a.machine,
        activatedAt: a.activated_at,
        endedAt: a.ended_at,
        endReason: a.end_reason,
        appVersion: a.app_version,
      })),
      payments: paid.map((p) => ({ paidOn: p.paid_on, amount: p.amount, note: p.note })),
    };
  });
}

/** A new licence; its key is returned this once and only its hash is kept. */
export async function createLicence(
  db: D1Like,
  input: { company: string; users: number; supportUntil: string; notes?: string },
  now: Date,
): Promise<{ id: number; key: string }> {
  const company = input.company.trim();
  if (company === "" || !Number.isInteger(input.users) || input.users < 1 || input.users > 1000 || !isDate(input.supportUntil))
    throw new Refused("invalid_input");
  const key = newKey();
  const row = await db
    .prepare("INSERT INTO licences (key_hash, key_hint, company, users, support_until, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id")
    .bind(await sha256(key), key.slice(-4), company, input.users, input.supportUntil, (input.notes ?? "").trim(), now.toISOString())
    .first<{ id: number }>();
  return { id: row!.id, key };
}

async function licenceExists(db: D1Like, id: number): Promise<void> {
  if (!(await db.prepare("SELECT 1 AS found FROM licences WHERE id = ?").bind(id).first())) throw new Refused("not_found");
}

/** A replacement key for a customer who lost theirs; the old key stops working, the PC keeps its licence. */
export async function replaceKey(db: D1Like, id: number): Promise<string> {
  await licenceExists(db, id);
  const key = newKey();
  await db
    .prepare("UPDATE licences SET key_hash = ?, key_hint = ? WHERE id = ?")
    .bind(await sha256(key), key.slice(-4), id)
    .run();
  return key;
}

export async function recordPayment(db: D1Like, id: number, input: { paidOn: string; amount: number; note?: string }, now: Date): Promise<void> {
  await licenceExists(db, id);
  if (!isDate(input.paidOn) || !Number.isInteger(input.amount) || input.amount <= 0) throw new Refused("invalid_input");
  await db
    .prepare("INSERT INTO payments (licence_id, paid_on, amount, note, recorded_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, input.paidOn, input.amount, (input.note ?? "").trim(), now.toISOString())
    .run();
}

/** Changes the support end date or the number of users; the customer activates again to get the new file. */
export async function updateLicence(db: D1Like, id: number, input: { supportUntil?: string; users?: number }): Promise<void> {
  await licenceExists(db, id);
  if (input.supportUntil !== undefined) {
    if (!isDate(input.supportUntil)) throw new Refused("invalid_input");
    await db.prepare("UPDATE licences SET support_until = ? WHERE id = ?").bind(input.supportUntil, id).run();
  }
  if (input.users !== undefined) {
    if (!Number.isInteger(input.users) || input.users < 1 || input.users > 1000) throw new Refused("invalid_input");
    await db.prepare("UPDATE licences SET users = ? WHERE id = ?").bind(input.users, id).run();
  }
}

/** Ends the current activation and clears the moves, so the customer can activate on any PC. */
export async function resetActivations(db: D1Like, id: number, now: Date): Promise<void> {
  await licenceExists(db, id);
  const at = now.toISOString();
  await db.batch([
    db.prepare("UPDATE activations SET ended_at = ?, end_reason = 'reset' WHERE licence_id = ? AND ended_at IS NULL").bind(at, id),
    db.prepare("UPDATE activations SET end_reason = 'reset' WHERE licence_id = ? AND end_reason = 'move'").bind(id),
  ]);
}

/** Revokes a licence: the key no longer activates. A PC that has its file keeps it until it activates again. */
export async function revokeLicence(db: D1Like, id: number, now: Date): Promise<void> {
  await licenceExists(db, id);
  const at = now.toISOString();
  await db.batch([
    db.prepare("UPDATE licences SET revoked_at = ? WHERE id = ?").bind(at, id),
    db.prepare("UPDATE activations SET ended_at = ?, end_reason = 'revoke' WHERE licence_id = ? AND ended_at IS NULL").bind(at, id),
  ]);
}
