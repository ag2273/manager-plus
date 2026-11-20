import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { Business } from "./business";

const manager = { name: "أيمن", password: "كلمة سر قوية" };
const shop = { name: "شركة النور للكمبيوتر", address: "الدقي", taxRegistrationNumber: "", vatRegistered: true, fiscalYearStartMonth: 1 };

function newShop(): Business {
  return Business.create(":memory:", shop, manager);
}

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "manager-plus-")), "shop.mplus");
}

function rentEntry(business: Business) {
  const id = (code: string) => business.accounts().find((a) => a.code === code)!.id;
  return { date: "2026-11-01", memo: "إيجار", lines: [{ accountId: id("6100"), debit: 100 }, { accountId: id("1110"), credit: 100 }] };
}

describe("the first manager", () => {
  test("creating a business makes its first user a manager, signed in", () => {
    const business = newShop();

    expect(business.currentUser()).toEqual(expect.objectContaining({ name: "أيمن", role: "manager", active: true }));
    expect(business.users()).toHaveLength(1);
  });

  test("a business cannot be created without a manager name and a password of at least 6 characters", () => {
    expect(() => Business.create(":memory:", shop, { name: " ", password: "123456" })).toThrow(
      expect.objectContaining({ code: "user_name_required" }),
    );
    expect(() => Business.create(":memory:", shop, { name: "أيمن", password: "12345" })).toThrow(
      expect.objectContaining({ code: "password_too_short" }),
    );
  });

  test("passwords are never stored as typed", () => {
    const path = tempFile();
    Business.create(path, shop, manager).close();

    const raw = new Database(path);
    const stored = JSON.stringify(raw.prepare("SELECT * FROM users").all());
    raw.close();
    expect(stored).not.toContain(manager.password);
  });
});

describe("signing in", () => {
  test("an opened file must be signed into before anything else but its settings", () => {
    const path = tempFile();
    Business.create(path, shop, manager).close();

    const file = Business.open(path);

    expect(file.settings().name).toBe(shop.name);
    expect(file.currentUser()).toBeNull();
    expect(() => file.accounts()).toThrow(expect.objectContaining({ code: "sign_in_required" }));
    file.close();
  });

  test("signing in with the right password works; a wrong one is refused", () => {
    const path = tempFile();
    Business.create(path, shop, manager).close();
    const file = Business.open(path);

    expect(() => file.signIn("أيمن", "غلط غلط")).toThrow(expect.objectContaining({ code: "sign_in_failed" }));
    expect(() => file.signIn("مش موجود", manager.password)).toThrow(expect.objectContaining({ code: "sign_in_failed" }));
    const session = file.signIn(" أيمن ", manager.password);

    expect(session.currentUser()?.name).toBe("أيمن");
    expect(session.accounts().length).toBeGreaterThan(0);
    file.close();
  });

  test("a deactivated user cannot sign in", () => {
    const business = newShop();
    const id = business.addUser({ name: "سارة", role: "cashier", password: "123456" });
    business.deactivateUser(id);

    expect(() => business.signIn("سارة", "123456")).toThrow(expect.objectContaining({ code: "sign_in_failed" }));
  });
});

describe("managing users", () => {
  test("a manager adds users with a role", () => {
    const business = newShop();

    business.addUser({ name: "سارة", role: "cashier", password: "123456" });
    business.addUser({ name: "محمود", role: "accountant", password: "123456" });

    expect(business.users().map((u) => [u.name, u.role])).toEqual([
      ["أيمن", "manager"],
      ["سارة", "cashier"],
      ["محمود", "accountant"],
    ]);
  });

  test("two users cannot share a name", () => {
    const business = newShop();

    expect(() => business.addUser({ name: "أيمن", role: "cashier", password: "123456" })).toThrow(
      expect.objectContaining({ code: "user_name_taken" }),
    );
  });

  test("a role must be one of the four", () => {
    const business = newShop();

    expect(() => business.addUser({ name: "سارة", role: "boss" as never, password: "123456" })).toThrow(
      expect.objectContaining({ code: "role_invalid" }),
    );
  });

  test("a manager can rename a user, change their role and reset their password", () => {
    const business = newShop();
    const id = business.addUser({ name: "سارة", role: "cashier", password: "123456" });

    business.updateUser(id, { name: "سارة أحمد", role: "storekeeper" });
    business.resetPassword(id, "654321");

    expect(business.signIn("سارة أحمد", "654321").currentUser()).toEqual(
      expect.objectContaining({ name: "سارة أحمد", role: "storekeeper" }),
    );
  });

  test("anyone can change their own password with the current one", () => {
    const business = newShop();
    business.addUser({ name: "سارة", role: "cashier", password: "123456" });
    const sara = business.signIn("سارة", "123456");

    expect(() => sara.changeOwnPassword("خطأ", "abcdef")).toThrow(expect.objectContaining({ code: "sign_in_failed" }));
    sara.changeOwnPassword("123456", "abcdef");

    expect(business.signIn("سارة", "abcdef").currentUser()?.name).toBe("سارة");
  });

  test("the last active manager cannot be removed or demoted", () => {
    const business = newShop();
    const me = business.currentUser()!.id;

    expect(() => business.deactivateUser(me)).toThrow(expect.objectContaining({ code: "last_manager" }));
    expect(() => business.updateUser(me, { role: "cashier" })).toThrow(expect.objectContaining({ code: "last_manager" }));

    const second = business.addUser({ name: "منى", role: "manager", password: "123456" });
    business.deactivateUser(me);
    expect(business.users().find((u) => u.id === me)?.active).toBe(false);
    expect(business.users().find((u) => u.id === second)?.active).toBe(true);
  });
});

describe("what each role may do", () => {
  function as(role: "accountant" | "cashier" | "storekeeper") {
    const business = newShop();
    business.addUser({ name: "موظف", role, password: "123456" });
    return { manager: business, user: business.signIn("موظف", "123456") };
  }

  test("only a manager manages users", () => {
    for (const role of ["accountant", "cashier", "storekeeper"] as const) {
      const { user } = as(role);
      expect(() => user.addUser({ name: "جديد", role: "cashier", password: "123456" })).toThrow(
        expect.objectContaining({ code: "not_allowed" }),
      );
      expect(() => user.users()).toThrow(expect.objectContaining({ code: "not_allowed" }));
    }
  });

  test("an accountant keeps the books; a cashier and a storekeeper cannot", () => {
    const { manager, user: accountant } = as("accountant");
    accountant.postJournalEntry(rentEntry(manager));
    expect(accountant.trialBalance("2026-11-30").totalDebit).toBe(100);

    for (const role of ["cashier", "storekeeper"] as const) {
      const { manager: m, user } = as(role);
      expect(() => user.postJournalEntry(rentEntry(m))).toThrow(expect.objectContaining({ code: "not_allowed" }));
      expect(() => user.trialBalance("2026-11-30")).toThrow(expect.objectContaining({ code: "not_allowed" }));
    }
  });

  test("a storekeeper manages items; a cashier can only look them up", () => {
    const { manager, user: storekeeper } = as("storekeeper");
    const taxCodeId = manager.taxCodes()[0]!.id;
    const item = { nameAr: "راوتر", baseUnit: "قطعة", barcode: "111", salePrice: 150_000, taxCodeId };
    storekeeper.addItem(item);

    const { manager: m2, user: cashier } = as("cashier");
    m2.addItem(item);
    expect(cashier.findByBarcode("111")?.nameAr).toBe("راوتر");
    expect(() => cashier.addItem({ ...item, barcode: "222" })).toThrow(expect.objectContaining({ code: "not_allowed" }));
  });
});

describe("the audit log", () => {
  test("every change records who made it and when, newest first", () => {
    const business = newShop();
    business.addUser({ name: "محمود", role: "accountant", password: "123456" });
    const accountant = business.signIn("محمود", "123456");

    const entryId = accountant.postJournalEntry(rentEntry(business));
    business.addAccount({ code: "6800", name: "دعاية", type: "expense" });

    const log = business.auditLog();
    expect(log.slice(0, 3)).toEqual([
      expect.objectContaining({ userName: "أيمن", action: "addAccount" }),
      expect.objectContaining({ userName: "محمود", action: "postJournalEntry", entityId: entryId }),
      expect.objectContaining({ userName: "أيمن", action: "addUser" }),
    ]);
    expect(log[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test("passwords never appear in the audit log", () => {
    const business = newShop();
    const id = business.addUser({ name: "سارة", role: "cashier", password: "سر-سارة-1" });
    business.resetPassword(id, "سر-سارة-2");

    expect(JSON.stringify(business.auditLog())).not.toContain("سر-سارة");
  });

  test("reading does not write to the audit log, and a refused command leaves no trace", () => {
    const business = newShop();
    const before = business.auditLog().length;

    business.accounts();
    business.trialBalance("2026-11-30");
    expect(() => business.addAccount({ code: "6100", name: "مكرر", type: "expense" })).toThrow();

    expect(business.auditLog()).toHaveLength(before);
  });

  test("a cashier cannot read the audit log", () => {
    const business = newShop();
    business.addUser({ name: "سارة", role: "cashier", password: "123456" });

    expect(() => business.signIn("سارة", "123456").auditLog()).toThrow(expect.objectContaining({ code: "not_allowed" }));
  });
});
