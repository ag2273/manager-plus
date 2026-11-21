import { describe, expect, test } from "vitest";
import { Business } from "./business";

const manager = { name: "أيمن", password: "كلمة سر قوية" };
const shop = { name: "شركة النور للكمبيوتر", address: "", taxRegistrationNumber: "", vatRegistered: true, fiscalYearStartMonth: 1 };

function setup() {
  const business = Business.create(":memory:", shop, manager);
  const account = (role: string) => business.accounts().find((a) => a.role === role)!.id;
  const named = (name: string) => business.accounts().find((a) => a.name === name)!.id;
  const capital = account("capital");
  // 10,000.00 into the main cash and 50,000.00 into the bank.
  business.postJournalEntry({
    date: "2026-01-01",
    memo: "رأس المال",
    lines: [
      { accountId: account("main_cash"), debit: 1_000_000 },
      { accountId: account("bank"), debit: 5_000_000 },
      { accountId: capital, credit: 6_000_000 },
    ],
  });
  const supplier = business.addSupplier({ name: "شركة الكهرباء", phone: "", taxRegistrationNumber: "" });
  return { business, account, named, supplier };
}

function balanceOf(business: Business, accountId: number) {
  const row = business.trialBalance("2026-12-31").rows.find((r) => r.accountId === accountId);
  return row ? row.debit - row.credit : 0;
}

describe("money accounts", () => {
  test("cash, bank and wallet accounts are listed with balances from the ledger", () => {
    const s = setup();
    const extra = s.business.addAccount({ code: "1125", name: "بنك مصر", type: "asset" });
    const list = s.business.moneyAccounts("2026-12-31");
    expect(list.map((a) => [a.code, a.balance])).toEqual([
      ["1100", 0],
      ["1110", 1_000_000],
      ["1120", 5_000_000],
      ["1125", 0],
      ["1130", 0],
      ["1140", 0],
    ]);
    expect(list.find((a) => a.id === extra)!.name).toBe("بنك مصر");
  });

  test("an expense: Dr the expense and input VAT, Cr the money account or the supplier", () => {
    const s = setup();
    const rent = s.named("الإيجار");
    const power = s.named("الكهرباء والمياه");
    const paid = s.business.recordExpense({
      date: "2026-02-01",
      expenseAccountId: rent,
      amount: 500_000,
      vat: 0,
      paidFrom: { accountId: s.account("main_cash") },
      memo: "إيجار فبراير",
    });
    expect(paid.number).toBe(1);
    s.business.recordExpense({
      date: "2026-02-02",
      expenseAccountId: power,
      amount: 100_000,
      vat: 14_000,
      paidFrom: { supplierId: s.supplier },
      memo: "",
    });

    expect(balanceOf(s.business, rent)).toBe(500_000);
    expect(balanceOf(s.business, s.account("main_cash"))).toBe(500_000);
    expect(balanceOf(s.business, power)).toBe(100_000);
    expect(balanceOf(s.business, s.account("input_vat"))).toBe(14_000);
    expect(s.business.supplierBalance(s.supplier)).toBe(114_000);
    expect(s.business.expenses().map((e) => [e.number, e.accountName, e.amount, e.vat, e.paidFrom])).toEqual([
      [2, "الكهرباء والمياه", 100_000, 14_000, "شركة الكهرباء"],
      [1, "الإيجار", 500_000, 0, "الخزينة الرئيسية"],
    ]);

    expect(() =>
      s.business.recordExpense({
        date: "2026-02-01",
        expenseAccountId: s.account("bank"),
        amount: 1,
        vat: 0,
        paidFrom: { accountId: s.account("main_cash") },
        memo: "",
      }),
    ).toThrow(expect.objectContaining({ code: "account_not_allowed" }));
    expect(() =>
      s.business.recordExpense({ date: "2026-02-01", expenseAccountId: rent, amount: 1, vat: 0, paidFrom: { accountId: rent }, memo: "" }),
    ).toThrow(expect.objectContaining({ code: "account_not_allowed" }));
  });

  test("a transfer moves money between two money accounts", () => {
    const s = setup();
    s.business.transferMoney({
      date: "2026-02-01",
      fromAccountId: s.account("bank"),
      toAccountId: s.account("main_cash"),
      amount: 200_000,
      memo: "سحب",
    });
    expect(balanceOf(s.business, s.account("bank"))).toBe(4_800_000);
    expect(balanceOf(s.business, s.account("main_cash"))).toBe(1_200_000);
    expect(() =>
      s.business.transferMoney({ date: "2026-02-01", fromAccountId: s.account("bank"), toAccountId: s.account("bank"), amount: 1, memo: "" }),
    ).toThrow(expect.objectContaining({ code: "account_not_allowed" }));
  });

  test("reconciling: lines are ticked as cleared, and the cleared balance is set against the statement", () => {
    const s = setup();
    const bank = s.account("bank");
    s.business.transferMoney({ date: "2026-02-01", fromAccountId: bank, toAccountId: s.account("main_cash"), amount: 200_000, memo: "" });
    s.business.recordExpense({
      date: "2026-02-03",
      expenseAccountId: s.named("عمولات البنوك والبطاقات"),
      amount: 1_500,
      vat: 0,
      paidFrom: { accountId: bank },
      memo: "",
    });

    const lines = s.business.accountLines(bank, "2026-01-01", "2026-12-31");
    expect(lines.map((l) => [l.debit, l.credit, l.cleared])).toEqual([
      [5_000_000, 0, false],
      [0, 200_000, false],
      [0, 1_500, false],
    ]);
    s.business.setCleared(bank, [lines[0]!.lineId, lines[1]!.lineId], true);
    const rec = s.business.reconciliation(bank, 4_800_000);
    expect(rec).toEqual({ balance: 4_798_500, cleared: 4_800_000, statement: 4_800_000, difference: 0 });
    expect(s.business.reconciliation(bank, 4_798_500).difference).toBe(-1_500);
    expect(() => s.business.setCleared(s.account("main_cash"), [lines[2]!.lineId], true)).toThrow(
      expect.objectContaining({ code: "line_not_found" }),
    );
  });

  test("nothing can be posted on or before the lock date", () => {
    const s = setup();
    s.business.setLockDate("2026-01-31");
    expect(s.business.lockDate()).toBe("2026-01-31");
    expect(() =>
      s.business.transferMoney({ date: "2026-01-31", fromAccountId: s.account("bank"), toAccountId: s.account("main_cash"), amount: 1, memo: "" }),
    ).toThrow(expect.objectContaining({ code: "period_locked" }));
    s.business.transferMoney({ date: "2026-02-01", fromAccountId: s.account("bank"), toAccountId: s.account("main_cash"), amount: 1, memo: "" });
    s.business.setLockDate(null);
    s.business.transferMoney({ date: "2026-01-15", fromAccountId: s.account("bank"), toAccountId: s.account("main_cash"), amount: 1, memo: "" });

    s.business.addUser({ name: "سارة", role: "cashier", password: "123456" });
    expect(() => s.business.signIn("سارة", "123456").setLockDate("2026-12-31")).toThrow(expect.objectContaining({ code: "not_allowed" }));
  });

  test("voiding reverses the entry on the void date, keeps both in the ledger, and is audited", () => {
    const s = setup();
    const { entryId } = s.business.recordExpense({
      date: "2026-02-01",
      expenseAccountId: s.named("الإيجار"),
      amount: 500_000,
      vat: 0,
      paidFrom: { accountId: s.account("main_cash") },
      memo: "",
    });
    s.business.voidEntry(entryId, "2026-02-05");
    expect(balanceOf(s.business, s.named("الإيجار"))).toBe(0);
    expect(balanceOf(s.business, s.account("main_cash"))).toBe(1_000_000);
    expect(s.business.expenses()[0]!.voided).toBe(true);
    expect(() => s.business.voidEntry(entryId, "2026-02-05")).toThrow(expect.objectContaining({ code: "entry_voided" }));
    expect(s.business.auditLog()[0]).toEqual(expect.objectContaining({ action: "voidEntry", entityId: entryId }));

    // Documents with their own undo (a receipt, an invoice) are not voided here.
    const amal = s.business.addCustomer({ name: "شركة الأمل", phone: "", taxRegistrationNumber: "" });
    s.business.receiveCustomerPayment({ date: "2026-02-01", partyId: amal, accountId: s.account("bank"), amount: 100, reference: "" });
    const receipt = s.business.accountLines(s.account("bank"), "2026-02-01", "2026-02-01")[0]!.entryId;
    expect(() => s.business.voidEntry(receipt, "2026-02-05")).toThrow(expect.objectContaining({ code: "entry_not_voidable" }));

    // An entry in a locked period is voided by a reversal dated after the lock.
    const early = s.business.transferMoney({
      date: "2026-02-08",
      fromAccountId: s.account("bank"),
      toAccountId: s.account("main_cash"),
      amount: 1,
      memo: "",
    });
    s.business.setLockDate("2026-02-10");
    expect(() => s.business.voidEntry(early.entryId, "2026-02-09")).toThrow(expect.objectContaining({ code: "period_locked" }));
    s.business.voidEntry(early.entryId, "2026-02-11");
    expect(s.business.moneyTransfers()[0]!.voided).toBe(true);
  });
});
