import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Business } from "../core/business";
import { type ServerIdentity, loadOrCreateIdentity } from "./certificate";
import { ConnectError, RemoteBusiness } from "./client";
import { type RunningServer, startServer } from "./server";

const manager = { name: "أيمن", password: "كلمة سر قوية" };
const cashier = { name: "سارة", password: "كلمة سر الكاشير" };
const shop = { name: "شركة النور للكمبيوتر", address: "", taxRegistrationNumber: "", vatRegistered: true, fiscalYearStartMonth: 1 };

let dir: string;
let identity: ServerIdentity;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "mplus-server-"));
  identity = await loadOrCreateIdentity(dir);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A business on its own server on a free local port, with a cashier and an item in stock. */
async function serve(): Promise<{ server: RunningServer; item: number; warehouse: number }> {
  const owner = Business.create(":memory:", shop, manager);
  owner.addUser({ ...cashier, role: "cashier" });
  const standard = owner.taxCodes().find((c) => c.kind === "standard")!.id;
  const item = owner.addItem({ nameAr: "كابل شبكة", baseUnit: "متر", salePrice: 1_000, taxCodeId: standard });
  const warehouse = owner.warehouses()[0]!.id;
  owner.postOpeningStock("2026-01-01", warehouse, [{ itemId: item, quantity: 1_000_000, unitCost: 500 }]);
  const server = await startServer(owner, identity, { port: 0, host: "127.0.0.1" });
  return { server, item, warehouse };
}

describe("server mode", () => {
  test("a client finds the business, signs in on the server and calls the facade", async () => {
    const { server } = await serve();
    const client = await RemoteBusiness.connect("127.0.0.1", server.port);

    expect(client.hello.settings.name).toBe("شركة النور للكمبيوتر");
    expect(client.fingerprint).toBe(identity.fingerprint);
    expect(await client.call("items", [])).toEqual(expect.objectContaining({ ok: false, code: "sign_in_required" }));
    expect(await client.signIn({ name: manager.name, password: "خطأ" })).toEqual(expect.objectContaining({ ok: false, code: "sign_in_failed" }));

    const signed = await client.signIn(manager);

    expect(signed).toEqual({ ok: true, value: expect.objectContaining({ name: "أيمن", role: "manager" }) });
    expect(await client.call("items", [])).toEqual({ ok: true, value: [expect.objectContaining({ nameAr: "كابل شبكة" })] });
    client.close();
    await server.close();
  });

  test("only the screens' allow-list is served, and the server checks the role on every call", async () => {
    const { server } = await serve();
    const client = await RemoteBusiness.connect("127.0.0.1", server.port);
    await client.signIn(cashier);

    expect(await client.call("close", [])).toEqual(expect.objectContaining({ ok: false, code: "not_allowed" }));
    expect(await client.call("trialBalance", ["2026-12-31"])).toEqual(expect.objectContaining({ ok: false, code: "not_allowed" }));
    expect((await client.call("items", [])).ok).toBe(true);
    client.close();
    await server.close();
  });

  test("two clients selling at the same time both succeed, in order, with no lost writes", async () => {
    const { server, item, warehouse } = await serve();
    const a = await RemoteBusiness.connect("127.0.0.1", server.port);
    const b = await RemoteBusiness.connect("127.0.0.1", server.port);
    await a.signIn(manager);
    await b.signIn(cashier);
    await Promise.all([a.call("openShift", [0]), b.call("openShift", [0])]);
    const sale = { date: "2026-02-01", warehouseId: warehouse, lines: [{ itemId: item, unit: "base", quantity: 1_000 }], cashReceived: 1_000 };

    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? a : b).call<{ number: number }>("postCashSale", [sale])));

    expect(results.every((r) => r.ok)).toBe(true);
    const numbers = results.map((r) => (r.ok ? r.value.number : 0)).sort((x, y) => x - y);
    expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(await a.call("stockOnHand", [item])).toEqual({ ok: true, value: expect.objectContaining({ total: 1_000_000 - 20_000 }) });
    a.close();
    b.close();
    await server.close();
  });

  test("a client that lost its connection resumes its session on the next call", async () => {
    const { server } = await serve();
    const client = await RemoteBusiness.connect("127.0.0.1", server.port);
    await client.signIn(manager);
    (client as unknown as { link: { close(): void } }).link.close();

    expect((await client.call("items", [])).ok).toBe(true);
    client.close();
    await server.close();
  });

  test("a server that is off gives server_unreachable, and a changed certificate is refused", async () => {
    const { server } = await serve();
    const client = await RemoteBusiness.connect("127.0.0.1", server.port);
    await client.signIn(manager);
    const port = server.port;
    await server.close();

    expect(await client.call("items", [])).toEqual(expect.objectContaining({ ok: false, code: "server_unreachable" }));
    await expect(RemoteBusiness.connect("127.0.0.1", port)).rejects.toEqual(expect.objectContaining({ code: "server_unreachable" }));

    const other = await serve();
    await expect(RemoteBusiness.connect("127.0.0.1", other.server.port, "00:11:22")).rejects.toBeInstanceOf(ConnectError);
    await expect(RemoteBusiness.connect("127.0.0.1", other.server.port, "00:11:22")).rejects.toEqual(expect.objectContaining({ code: "server_identity_changed" }));
    await other.server.close();
  });

  test("the server keeps its certificate across restarts so pinned clients still trust it", async () => {
    expect((await loadOrCreateIdentity(dir)).fingerprint).toBe(identity.fingerprint);
  });
});
