import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { Business } from "./business";

const manager = { name: "أيمن", password: "كلمة سر قوية" };

const shop = {
  name: "بقالة النور",
  address: "الدقي",
  taxRegistrationNumber: "",
  vatRegistered: true,
  fiscalYearStartMonth: 1,
};

function newShop(): Business {
  return Business.create(":memory:", shop, manager);
}

function account(business: Business, code: string) {
  const found = business.accounts().find((a) => a.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found;
}

describe("the starting chart of accounts", () => {
  test("a new business starts with the Egyptian retail chart of accounts", () => {
    const business = newShop();

    expect(business.accounts().map((a) => [a.code, a.name, a.type])).toEqual(
      expect.arrayContaining([
        ["1100", "نقدية الدرج", "asset"],
        ["1200", "العملاء", "asset"],
        ["1300", "المخزون", "asset"],
        ["2100", "الموردون", "liability"],
        ["2200", "ضريبة القيمة المضافة على المبيعات", "liability"],
        ["3100", "رأس المال", "equity"],
        ["3900", "أرصدة افتتاحية", "equity"],
        ["4100", "المبيعات", "income"],
        ["5100", "تكلفة البضاعة المباعة", "expense"],
        ["6100", "الإيجار", "expense"],
      ]),
    );
  });

  test("a new business has an empty, balanced trial balance", () => {
    const tb = newShop().trialBalance("2026-12-31");

    expect(tb).toEqual({ rows: [], totalDebit: 0, totalCredit: 0 });
  });
});

describe("journal entries", () => {
  test("a balanced entry shows in the trial balance", () => {
    const business = newShop();
    const rent = account(business, "6100");
    const cash = account(business, "1110");

    business.postJournalEntry({
      date: "2026-11-01",
      memo: "إيجار نوفمبر",
      lines: [
        { accountId: rent.id, debit: 500_000 },
        { accountId: cash.id, credit: 500_000 },
      ],
    });

    expect(business.trialBalance("2026-11-30")).toEqual({
      rows: [
        { accountId: cash.id, code: "1110", name: "الخزينة الرئيسية", type: "asset", debit: 0, credit: 500_000 },
        { accountId: rent.id, code: "6100", name: "الإيجار", type: "expense", debit: 500_000, credit: 0 },
      ],
      totalDebit: 500_000,
      totalCredit: 500_000,
    });
  });
});

describe("refusing bad journal entries", () => {
  function rentEntry(business: Business, lines: { code: string; debit?: number; credit?: number }[]) {
    return {
      date: "2026-11-01",
      memo: "test",
      lines: lines.map(({ code, ...amounts }) => ({ accountId: account(business, code).id, ...amounts })),
    };
  }

  test.each([
    ["debits and credits differ", [{ code: "6100", debit: 500_000 }, { code: "1110", credit: 499_999 }], "entry_unbalanced"],
    ["only one line", [{ code: "6100", debit: 0 }], "entry_needs_two_lines"],
    ["a line has both a debit and a credit", [{ code: "6100", debit: 100, credit: 100 }, { code: "1110", credit: 0 }], "line_amount_invalid"],
    ["a line has no amount", [{ code: "6100", debit: 100 }, { code: "1110", credit: 100 }, { code: "1120" }], "line_amount_invalid"],
    ["an amount is a fraction of a piastre", [{ code: "6100", debit: 100.5 }, { code: "1110", credit: 100.5 }], "line_amount_invalid"],
    ["an amount is negative", [{ code: "6100", debit: -100 }, { code: "1110", credit: -100 }], "line_amount_invalid"],
  ])("refused when %s, and nothing is written", (_why, lines, code) => {
    const business = newShop();

    expect(() => business.postJournalEntry(rentEntry(business, lines))).toThrow(expect.objectContaining({ code }));
    expect(business.trialBalance("2026-12-31").rows).toEqual([]);
  });

  test("refused when an account doesn't exist", () => {
    const business = newShop();

    expect(() =>
      business.postJournalEntry({
        date: "2026-11-01",
        memo: "",
        lines: [
          { accountId: 9999, debit: 100 },
          { accountId: account(business, "1110").id, credit: 100 },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: "account_not_found" }));
  });

  test.each(["2026-13-01", "2026-02-30", "01/11/2026", ""])("refused when the date is not a real date (%s)", (date) => {
    const business = newShop();

    expect(() => business.postJournalEntry({ ...rentEntry(business, [{ code: "6100", debit: 1 }, { code: "1110", credit: 1 }]), date })).toThrow(
      expect.objectContaining({ code: "date_invalid" }),
    );
  });
});

describe("trial balance dates", () => {
  test("entries after the trial balance date are left out", () => {
    const business = newShop();
    const rent = account(business, "6100").id;
    const cash = account(business, "1110").id;
    business.postJournalEntry({ date: "2026-11-01", memo: "", lines: [{ accountId: rent, debit: 100 }, { accountId: cash, credit: 100 }] });
    business.postJournalEntry({ date: "2026-12-01", memo: "", lines: [{ accountId: rent, debit: 200 }, { accountId: cash, credit: 200 }] });

    expect(business.trialBalance("2026-11-30").totalDebit).toBe(100);
    expect(business.trialBalance("2026-12-31").totalDebit).toBe(300);
  });

  test("an account whose movements cancel out is not listed", () => {
    const business = newShop();
    const bank = account(business, "1120").id;
    const cash = account(business, "1110").id;
    business.postJournalEntry({ date: "2026-11-01", memo: "", lines: [{ accountId: bank, debit: 100 }, { accountId: cash, credit: 100 }] });
    business.postJournalEntry({ date: "2026-11-02", memo: "", lines: [{ accountId: cash, debit: 100 }, { accountId: bank, credit: 100 }] });

    expect(business.trialBalance("2026-11-30")).toEqual({ rows: [], totalDebit: 0, totalCredit: 0 });
  });
});

describe("managing accounts", () => {
  test("the accountant can add an account", () => {
    const business = newShop();

    const id = business.addAccount({ code: "6800", name: "دعاية وإعلان", type: "expense" });

    expect(business.accounts().find((a) => a.id === id)).toEqual({
      id,
      code: "6800",
      name: "دعاية وإعلان",
      type: "expense",
      role: null,
      active: true,
    });
  });

  test("two accounts cannot share a code", () => {
    const business = newShop();

    expect(() => business.addAccount({ code: "6100", name: "إيجار مخزن", type: "expense" })).toThrow(
      expect.objectContaining({ code: "account_code_taken" }),
    );
  });

  test("an account needs a code and a name", () => {
    const business = newShop();

    expect(() => business.addAccount({ code: " ", name: "x", type: "expense" })).toThrow(
      expect.objectContaining({ code: "account_code_required" }),
    );
    expect(() => business.addAccount({ code: "6900", name: "", type: "expense" })).toThrow(
      expect.objectContaining({ code: "account_name_required" }),
    );
  });

  test("an account can be renamed and renumbered, and keeps its history", () => {
    const business = newShop();
    const rent = account(business, "6100");
    const cash = account(business, "1110");
    business.postJournalEntry({ date: "2026-11-01", memo: "", lines: [{ accountId: rent.id, debit: 100 }, { accountId: cash.id, credit: 100 }] });

    business.updateAccount(rent.id, { code: "6110", name: "إيجار المحل" });

    expect(business.trialBalance("2026-11-30").rows).toContainEqual(
      expect.objectContaining({ accountId: rent.id, code: "6110", name: "إيجار المحل", debit: 100 }),
    );
  });

  test("nothing can be posted to an inactive account", () => {
    const business = newShop();
    const rent = account(business, "6100");
    business.deactivateAccount(rent.id);

    expect(() =>
      business.postJournalEntry({
        date: "2026-11-01",
        memo: "",
        lines: [{ accountId: rent.id, debit: 100 }, { accountId: account(business, "1110").id, credit: 100 }],
      }),
    ).toThrow(expect.objectContaining({ code: "account_inactive" }));
    expect(account(business, "6100").active).toBe(false);
  });

  test("an unused account can be deleted", () => {
    const business = newShop();
    const id = business.addAccount({ code: "6800", name: "دعاية وإعلان", type: "expense" });

    business.deleteAccount(id);

    expect(business.accounts().some((a) => a.id === id)).toBe(false);
  });

  test("an account with postings cannot be deleted", () => {
    const business = newShop();
    const rent = account(business, "6100");
    business.postJournalEntry({ date: "2026-11-01", memo: "", lines: [{ accountId: rent.id, debit: 100 }, { accountId: account(business, "1110").id, credit: 100 }] });

    expect(() => business.deleteAccount(rent.id)).toThrow(expect.objectContaining({ code: "account_has_postings" }));
  });

  test("an account the app posts to automatically cannot be deleted or deactivated", () => {
    const business = newShop();
    const sales = account(business, "4100");

    expect(() => business.deleteAccount(sales.id)).toThrow(expect.objectContaining({ code: "account_is_system" }));
    expect(() => business.deactivateAccount(sales.id)).toThrow(expect.objectContaining({ code: "account_is_system" }));
  });
});

describe("opening balances", () => {
  test("opening balances post against the opening balances account so the books balance", () => {
    const business = newShop();
    const cash = account(business, "1110");
    const stock = account(business, "1300");
    const payables = account(business, "2100");
    const opening = account(business, "3900");

    business.postOpeningBalances("2026-01-01", [
      { accountId: cash.id, debit: 1_000_000 },
      { accountId: stock.id, debit: 5_000_000 },
      { accountId: payables.id, credit: 1_500_000 },
    ]);

    const tb = business.trialBalance("2026-01-01");
    expect(tb.rows).toContainEqual(expect.objectContaining({ accountId: opening.id, debit: 0, credit: 4_500_000 }));
    expect(tb.totalDebit).toBe(6_000_000);
    expect(tb.totalCredit).toBe(6_000_000);
  });
});

describe("keeping the books in the file", () => {
  test("posted entries are still there after the file is reopened", () => {
    const path = join(mkdtempSync(join(tmpdir(), "manager-plus-")), "shop.mplus");
    const business = Business.create(path, shop, manager);
    business.postJournalEntry({
      date: "2026-11-01",
      memo: "",
      lines: [{ accountId: account(business, "6100").id, debit: 100 }, { accountId: account(business, "1110").id, credit: 100 }],
    });
    business.close();

    const file = Business.open(path);
    const reopened = file.signIn(manager.name, manager.password);

    expect(reopened.trialBalance("2026-11-30").totalDebit).toBe(100);
    reopened.close();
  });
});

describe("more account rules", () => {
  test("renumbering an account to a code in use is refused", () => {
    const business = newShop();
    const rent = account(business, "6100");

    expect(() => business.updateAccount(rent.id, { code: "1110" })).toThrow(expect.objectContaining({ code: "account_code_taken" }));
  });

  test("a deactivated account can be reactivated and posted to again", () => {
    const business = newShop();
    const rent = account(business, "6100");
    business.deactivateAccount(rent.id);

    business.reactivateAccount(rent.id);
    business.postJournalEntry({ date: "2026-11-01", memo: "", lines: [{ accountId: rent.id, debit: 100 }, { accountId: account(business, "1110").id, credit: 100 }] });

    expect(business.trialBalance("2026-11-30").totalDebit).toBe(100);
  });

  test("opening balances that already balance post no balancing line", () => {
    const business = newShop();

    business.postOpeningBalances("2026-01-01", [
      { accountId: account(business, "1110").id, debit: 1_000 },
      { accountId: account(business, "3100").id, credit: 1_000 },
    ]);

    expect(business.trialBalance("2026-01-01").rows.map((r) => r.code)).toEqual(["1110", "3100"]);
  });
});
