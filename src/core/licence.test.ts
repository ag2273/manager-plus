import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, test } from "vitest";
import { Business } from "./business";
import { BusinessError } from "./errors";
import { type LicenceClient, type LicenceFile, type LicencePayload, type LicenceState, Licensing } from "./licence/licence";

const manager = { name: "أيمن", password: "كلمة سر قوية" };
const shop = { name: "شركة النور للكمبيوتر", address: "", taxRegistrationNumber: "", vatRegistered: false, fiscalYearStartMonth: 1 };
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const MACHINE = "machine-a";

const day = (n: number, hours = 0) => new Date(Date.UTC(2026, 10, 1 + n, 9 + hours));

function signed(changes: Partial<LicencePayload> = {}, key = privateKey): LicenceFile {
  const payload: LicencePayload = {
    licenceId: "L-1",
    company: "شركة النور للكمبيوتر",
    machine: MACHINE,
    users: 3,
    supportUntil: "2027-11-30",
    issuedAt: "2026-11-20T10:00:00Z",
    ...changes,
  };
  const data = Buffer.from(JSON.stringify(payload));
  return { payload: data.toString("base64"), signature: sign(null, data, key).toString("base64") };
}

/** A licence server that knows one key, and can be told to refuse or to be down. */
function fakeServer(answer: (key: string, machine: string) => LicenceFile | Error = (_key, machine) => signed({ machine })) {
  const calls: { key: string; machine: string }[] = [];
  const client: LicenceClient = {
    async activate(key, machine) {
      calls.push({ key, machine });
      const result = answer(key, machine);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { client, calls };
}

function licensing(options: { client?: LicenceClient; machine?: string; state?: LicenceState | null } = {}) {
  let state: LicenceState | null = options.state ?? null;
  const store = { read: () => state, write: (s: LicenceState) => (state = structuredClone(s)) };
  const l = new Licensing({ store, client: options.client ?? fakeServer().client, publicKeyPem, machine: options.machine ?? MACHINE });
  return { l, state: () => state };
}

describe("the trial", () => {
  test("starts with the first business file and lasts 14 days, then the app is read-only", () => {
    const { l } = licensing();
    expect(l.status(day(0))).toMatchObject({ mode: "trial", daysLeft: 14 });
    l.noteFile(day(0), day(0));
    expect(l.status(day(1))).toMatchObject({ mode: "trial", daysLeft: 13 });
    expect(l.status(day(13, 23))).toMatchObject({ mode: "trial", daysLeft: 1 });
    expect(l.status(day(14))).toEqual({ mode: "read_only", reason: "trial_over" });
    expect(l.limits(day(14))).toEqual({ readOnly: "trial_over", users: null });
  });

  test("opening an older file moves the start back, so a fresh install doesn't give a new trial", () => {
    const { l } = licensing();
    l.noteFile(day(20), day(20));
    l.noteFile(day(0), day(20));
    expect(l.status(day(20))).toEqual({ mode: "read_only", reason: "trial_over" });
  });

  test("turning the clock back is noticed; a summer-time change is not", () => {
    const { l } = licensing();
    l.noteFile(day(0), day(0));
    expect(l.status(day(10)).mode).toBe("trial");
    expect(l.status(day(9, 23)).mode).toBe("trial");
    expect(l.status(day(5))).toEqual({ mode: "read_only", reason: "clock_back" });
    // Put right, the trial carries on where it was.
    expect(l.status(day(10, 1))).toMatchObject({ mode: "trial", daysLeft: 4 });
  });
});

describe("the licence file", () => {
  test("activating keeps the signed licence; it is checked offline at every start", async () => {
    const server = fakeServer();
    const { l, state } = licensing({ client: server.client });
    l.noteFile(day(0), day(0));
    expect(await l.activate("  abcd-efgh ", day(20))).toEqual({
      mode: "licensed",
      company: "شركة النور للكمبيوتر",
      users: 3,
      supportUntil: "2027-11-30",
    });
    expect(server.calls).toEqual([{ key: "ABCD-EFGH", machine: MACHINE }]);
    // A later start, with the clock anywhere, reads the same licence from the saved file alone.
    const again = licensing({ state: state(), client: fakeServer(() => new Error("offline")).client });
    expect(again.l.status(day(400)).mode).toBe("licensed");
    expect(again.l.limits(day(400))).toEqual({ readOnly: null, users: 3 });
  });

  test("a tampered file, one signed with another key, or one for another PC opens read-only", () => {
    const base = { trialStartedAt: day(0).toISOString(), lastSeenAt: day(0).toISOString() };
    const good = signed();
    const raised = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(good.payload, "base64").toString()), users: 50 })).toString("base64");
    const stranger = generateKeyPairSync("ed25519").privateKey;
    const status = (licence: LicenceFile) => licensing({ state: { ...base, licence } }).l.status(day(1));

    expect(status(good).mode).toBe("licensed");
    expect(status({ ...good, payload: raised })).toEqual({ mode: "read_only", reason: "licence_invalid" });
    expect(status(signed({}, stranger))).toEqual({ mode: "read_only", reason: "licence_invalid" });
    expect(status({ payload: "not base64 json", signature: "" })).toEqual({ mode: "read_only", reason: "licence_invalid" });
    expect(status(signed({ machine: "machine-b" }))).toEqual({ mode: "read_only", reason: "licence_other_machine" });
  });

  test("the server's refusals come through; a network failure says the server can't be reached; a bad answer isn't kept", async () => {
    const refusing = licensing({ client: fakeServer(() => new BusinessError("licence_moves_exhausted", "no moves")).client });
    await expect(refusing.l.activate("KEY", day(0))).rejects.toMatchObject({ code: "licence_moves_exhausted" });
    const down = licensing({ client: fakeServer(() => new Error("ENOTFOUND")).client });
    await expect(down.l.activate("KEY", day(0))).rejects.toMatchObject({ code: "licence_unreachable" });
    await expect(down.l.activate(" ", day(0))).rejects.toMatchObject({ code: "licence_key_invalid" });
    const forged = licensing({ client: fakeServer(() => signed({}, generateKeyPairSync("ed25519").privateKey)).client });
    await expect(forged.l.activate("KEY", day(0))).rejects.toMatchObject({ code: "licence_invalid" });
    expect(forged.state()).toBeNull();
  });

  test("updates install only when released within the support plan; read-only installs none", async () => {
    const { l } = licensing();
    l.noteFile(day(0), day(0));
    expect(l.updateAllowed("2030-01-01", day(1))).toBe(true);
    await l.activate("KEY", day(2));
    expect(l.updateAllowed("2027-11-30", day(3))).toBe(true);
    expect(l.updateAllowed("2027-12-01", day(3))).toBe(false);
    const expired = licensing();
    expired.l.noteFile(day(0), day(0));
    expect(expired.l.updateAllowed("2026-11-01", day(30))).toBe(false);
  });
});

describe("the books under the licence", () => {
  function shopWithStaff() {
    const business = Business.create(":memory:", shop, manager);
    for (const name of ["سارة", "محمد", "منى"]) business.addUser({ name, password: "كلمة سر قوية", role: "cashier" });
    const item = business.addItem({ nameAr: "ماوس", baseUnit: "قطعة", salePrice: 20_000, taxCodeId: business.taxCodes()[0]!.id });
    return { business, item, main: business.warehouses()[0]!.id };
  }

  test("read-only refuses every new record, but reading, backups and passwords still work", () => {
    const { business, item, main } = shopWithStaff();
    business.setLicenceLimits({ readOnly: "trial_over", users: null });
    expect(() => business.addItem({ nameAr: "كيبورد", baseUnit: "قطعة", salePrice: 30_000, taxCodeId: business.taxCodes()[0]!.id })).toThrow(
      expect.objectContaining({ code: "read_only" }),
    );
    expect(() => business.openShift(0)).toThrow(expect.objectContaining({ code: "read_only" }));
    expect(() =>
      business.postCashSale({
        date: "2026-11-20",
        warehouseId: main,
        lines: [{ itemId: item, unit: "base", quantity: 1_000 }],
        cashReceived: 20_000,
      }),
    ).toThrow(expect.objectContaining({ code: "read_only" }));
    expect(business.items().length).toBe(1);
    expect(business.licenceMode()).toEqual({ readOnly: "trial_over", users: null, signedIn: 1 });
    business.changeOwnPassword(manager.password, "كلمة سر أقوى");

    business.setLicenceLimits({ readOnly: null, users: null });
    business.addItem({ nameAr: "كيبورد", baseUnit: "قطعة", salePrice: 30_000, taxCodeId: business.taxCodes()[0]!.id });
  });

  test("signing in beyond the licensed users is refused; the same person again, or after a sign-out, is not", () => {
    const { business } = shopWithStaff();
    business.setLicenceLimits({ readOnly: null, users: 2 });
    const sara = business.signIn("سارة", "كلمة سر قوية");
    expect(() => business.signIn("محمد", "كلمة سر قوية")).toThrow(expect.objectContaining({ code: "licence_users_exceeded" }));
    const saraAgain = business.signIn("سارة", "كلمة سر قوية");
    expect(business.licenceMode()).toEqual({ readOnly: null, users: 2, signedIn: 2 });
    sara.signOut();
    expect(() => business.signIn("محمد", "كلمة سر قوية")).toThrow(expect.objectContaining({ code: "licence_users_exceeded" }));
    saraAgain.signOut();
    expect(business.signIn("محمد", "كلمة سر قوية").currentUser()?.name).toBe("محمد");
  });
});
