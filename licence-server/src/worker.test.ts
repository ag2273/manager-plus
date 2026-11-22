import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { verifyLicence } from "../../src/core/licence/licence";
import type { D1Like, D1Statement } from "./licences";
import { type Env, handle } from "./worker";

/** D1 on an in-memory SQLite database, as far as the server uses it. */
function sqliteD1(): D1Like {
  const db = new Database(":memory:");
  db.exec(readFileSync(join(import.meta.dirname, "..", "schema.sql"), "utf8"));
  const statement = (sql: string, values: unknown[] = []): D1Statement & { exec(): unknown } => ({
    bind: (...v) => statement(sql, v),
    first: async <T>() => (db.prepare(sql).get(...values) as T | undefined) ?? null,
    all: async <T>() => ({ results: db.prepare(sql).all(...values) as T[] }),
    run: async () => db.prepare(sql).run(...values),
    exec: () => db.prepare(sql).run(...values),
  });
  return {
    prepare: (sql) => statement(sql),
    batch: async (list) => db.transaction(() => list.map((s) => (s as ReturnType<typeof statement>).exec()))(),
  };
}

const keys = generateKeyPairSync("ed25519");
const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const env: Env = {
  DB: sqliteD1(),
  LICENCE_PRIVATE_KEY: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  ADMIN_PASSWORD: "admin secret",
};
const PC_A = "a".repeat(32);
const PC_B = "b".repeat(32);
const PC_C = "c".repeat(32);

function freshEnv(): Env {
  return { ...env, DB: sqliteD1() };
}

const at = (iso: string) => new Date(iso);
const admin = { Authorization: `Basic ${btoa("ayman:admin secret")}` };

async function call(
  e: Env,
  path: string,
  options: { body?: unknown; headers?: Record<string, string>; method?: string; now?: Date; ip?: string } = {},
) {
  const request = new Request(`https://licence.example${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": options.ip ?? "203.0.113.1", ...options.headers },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const response = await handle(request, e, options.now ?? at("2026-11-22T10:00:00Z"));
  const text = await response.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // The admin page is HTML.
  }
  return { status: response.status, data: data as Record<string, unknown> };
}

async function newLicence(e: Env, users = 3) {
  const created = await call(e, "/admin/api/licences", {
    headers: admin,
    body: { company: "شركة النور للكمبيوتر", users, supportUntil: "2027-11-30" },
  });
  return created.data as unknown as { id: number; key: string };
}

const activateOn = (e: Env, key: string, machine: string, now = "2026-11-22T10:00:00Z", ip?: string) =>
  call(e, "/v1/activate", { body: { key, machine, appVersion: "1.0.0" }, now: at(now), ...(ip ? { ip } : {}) });

describe("activation", () => {
  test("a key activates on a PC and returns a licence file the app accepts offline", async () => {
    const e = freshEnv();
    const { key } = await newLicence(e);
    expect(key).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const result = await activateOn(e, ` ${key.toLowerCase()} `, PC_A);
    expect(result.status).toBe(200);
    const payload = verifyLicence((result.data as unknown as { licence: { payload: string; signature: string } }).licence, publicKeyPem, PC_A);
    expect(payload).toMatchObject({ company: "شركة النور للكمبيوتر", machine: PC_A, users: 3, supportUntil: "2027-11-30" });
    // The same PC again gets a fresh file.
    expect((await activateOn(e, key, PC_A)).status).toBe(200);
  });

  test("the private key works as make-keys.mjs gives it: PKCS#8 DER in base64", async () => {
    const e = { ...freshEnv(), LICENCE_PRIVATE_KEY: keys.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64") };
    const { key } = await newLicence(e);
    const result = await activateOn(e, key, PC_A);
    expect(verifyLicence((result.data as unknown as { licence: { payload: string; signature: string } }).licence, publicKeyPem, PC_A).machine).toBe(PC_A);
  });

  test("a wrong key, a revoked key and bad input are refused", async () => {
    const e = freshEnv();
    const { id, key } = await newLicence(e);
    expect(await activateOn(e, "AAAA-BBBB-CCCC-DDDD", PC_A)).toEqual({ status: 404, data: { error: "licence_key_invalid" } });
    expect((await activateOn(e, key, "not a fingerprint")).status).toBe(400);
    await call(e, `/admin/api/licences/${id}/revoke`, { headers: admin, body: {} });
    expect(await activateOn(e, key, PC_A)).toEqual({ status: 403, data: { error: "licence_revoked" } });
  });

  test("a second PC takes the licence over at most twice in any 12 months; a reset clears that", async () => {
    const e = freshEnv();
    const { id, key } = await newLicence(e);
    await activateOn(e, key, PC_A, "2026-01-10T10:00:00Z");
    expect((await activateOn(e, key, PC_B, "2026-03-01T10:00:00Z")).status).toBe(200);
    expect((await activateOn(e, key, PC_A, "2026-06-01T10:00:00Z")).status).toBe(200);
    expect(await activateOn(e, key, PC_C, "2026-09-01T10:00:00Z")).toEqual({ status: 409, data: { error: "licence_moves_exhausted" } });
    // A year after the first move, one is free again.
    expect((await activateOn(e, key, PC_C, "2027-03-02T10:00:00Z")).status).toBe(200);
    expect(await activateOn(e, key, PC_B, "2027-03-03T10:00:00Z")).toEqual({ status: 409, data: { error: "licence_moves_exhausted" } });

    await call(e, `/admin/api/licences/${id}/reset`, { headers: admin, body: {} });
    expect((await activateOn(e, key, PC_B, "2027-03-04T10:00:00Z")).status).toBe(200);
    const [licence] = (await call(e, "/admin/api/licences", { headers: admin })).data as unknown as { machine: string; movesUsed: number }[];
    expect(licence).toMatchObject({ machine: PC_B, movesUsed: 0 });
  });

  test("activation is rate limited per address", async () => {
    const e = freshEnv();
    for (let i = 0; i < 10; i++) expect((await activateOn(e, "AAAA-BBBB-CCCC-DDDD", PC_A, undefined, "198.51.100.7")).status).toBe(404);
    expect(await activateOn(e, "AAAA-BBBB-CCCC-DDDD", PC_A, undefined, "198.51.100.7")).toEqual({
      status: 429,
      data: { error: "licence_rate_limited" },
    });
    expect((await activateOn(e, "AAAA-BBBB-CCCC-DDDD", PC_A, undefined, "198.51.100.8")).status).toBe(404);
    expect((await activateOn(e, "AAAA-BBBB-CCCC-DDDD", PC_A, "2026-11-22T11:00:00Z", "198.51.100.7")).status).toBe(404);
  });
});

describe("the admin page", () => {
  test("the bare address goes to the admin page", async () => {
    const e = freshEnv();
    const response = await handle(new Request("https://licence.example/"), e);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://licence.example/admin");
  });

  test("needs the password", async () => {
    const e = freshEnv();
    expect((await call(e, "/admin")).status).toBe(401);
    expect((await call(e, "/admin", { headers: { Authorization: `Basic ${btoa("ayman:wrong")}` } })).status).toBe(401);
    expect((await call(e, "/admin/api/licences", { body: { company: "x", users: 1, supportUntil: "2027-01-01" } })).status).toBe(401);
    const page = await call(e, "/admin", { headers: admin });
    expect(page.status).toBe(200);
    expect(String(page.data)).toContain("تراخيص Manager+");
  });

  test("creates keys, records payments, extends support and users, issues a new key; the app gets the new terms on its next activation", async () => {
    const e = freshEnv();
    const { id, key } = await newLicence(e, 2);
    await activateOn(e, key, PC_A);
    expect(
      (
        await call(e, `/admin/api/licences/${id}/payments`, {
          headers: admin,
          body: { paidOn: "2026-11-22", amount: 1_500_000, note: "ترخيص + سنة دعم" },
        })
      ).status,
    ).toBe(200);
    expect((await call(e, `/admin/api/licences/${id}/payments`, { headers: admin, body: { paidOn: "yesterday", amount: 5 } })).status).toBe(400);
    await call(e, `/admin/api/licences/${id}/update`, { headers: admin, body: { supportUntil: "2028-11-30", users: 5 } });

    const replaced = (await call(e, `/admin/api/licences/${id}/new-key`, { headers: admin, body: {} })).data as unknown as { key: string };
    expect((await activateOn(e, key, PC_A)).status).toBe(404);
    const renewed = await activateOn(e, replaced.key, PC_A);
    expect(verifyLicence((renewed.data as unknown as { licence: { payload: string; signature: string } }).licence, publicKeyPem, PC_A)).toMatchObject({
      users: 5,
      supportUntil: "2028-11-30",
    });

    const [licence] = (await call(e, "/admin/api/licences", { headers: admin })).data as unknown as Record<string, unknown>[];
    expect(licence).toMatchObject({
      company: "شركة النور للكمبيوتر",
      keyHint: replaced.key.slice(-4),
      users: 5,
      paid: 1_500_000,
      machine: PC_A,
      movesUsed: 0,
    });
    expect(JSON.stringify(licence)).not.toContain(replaced.key);
  });
});

describe("releases", () => {
  test("the newest signed manifest is served as it was published; publishing needs the admin", async () => {
    const e = freshEnv();
    expect(await call(e, "/v1/update")).toEqual({ status: 404, data: { error: "none" } });
    const first = { manifest: btoa(JSON.stringify({ version: "1.1.0" })), signature: "c2ln" };
    const second = { manifest: btoa(JSON.stringify({ version: "1.2.0" })), signature: "c2lnMg==" };
    expect((await call(e, "/admin/api/releases", { body: first })).status).toBe(401);
    expect((await call(e, "/admin/api/releases", { headers: admin, body: { manifest: "not json", signature: "x" } })).status).toBe(400);
    await call(e, "/admin/api/releases", { headers: admin, body: first });
    expect((await call(e, "/admin/api/releases", { headers: admin, body: second })).data).toEqual({ version: "1.2.0" });
    expect(await call(e, "/v1/update")).toEqual({ status: 200, data: second });
    expect(((await call(e, "/admin/api/releases", { headers: admin })).data as unknown as { version: string }[]).map((r) => r.version)).toEqual(["1.2.0", "1.1.0"]);
  });
});

