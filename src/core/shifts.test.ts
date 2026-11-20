import { describe, expect, test } from "vitest";
import { Business } from "./business";

const manager = { name: "أيمن", password: "كلمة سر قوية" };
const shop = { name: "بقالة النور", address: "الدقي", taxRegistrationNumber: "", vatRegistered: true, fiscalYearStartMonth: 1 };

function setup() {
  const business = Business.create(":memory:", shop, manager);
  const main = business.warehouses()[0]!.id;
  const standard = business.taxCodes().find((c) => c.kind === "standard")!.id;
  const soap = business.addItem({ nameAr: "منظف أطباق", baseUnit: "قطعة", barcode: "35", salePrice: 5_700, taxCodeId: standard });
  const supplier = business.addSupplier({ name: "المورد", phone: "", taxRegistrationNumber: "" });
  business.postPurchaseInvoice({
    date: "2026-11-01",
    supplierId: supplier,
    warehouseId: main,
    reference: "",
    lines: [{ itemId: soap, unit: "base", quantity: 100_000, unitPrice: 4_000 }],
  });
  const account = (role: string) => business.accounts().find((a) => a.role === role)!.id;
  const sell = (b: Business, pieces: number, cash = pieces * 5_700) =>
    b.postCashSale({ date: "2026-11-20", warehouseId: main, lines: [{ itemId: soap, unit: "base", quantity: pieces * 1000 }], cashReceived: cash });
  return { business, main, soap, account, sell };
}

function balanceOf(business: Business, accountId: number) {
  const row = business.trialBalance("2026-12-31").rows.find((r) => r.accountId === accountId);
  return row ? row.debit - row.credit : 0;
}

describe("shifts", () => {
  test("sales need an open shift", () => {
    const { business, sell } = setup();

    expect(() => sell(business, 1)).toThrow(expect.objectContaining({ code: "shift_required" }));
    business.openShift(50_000);
    expect(sell(business, 1).number).toBe(1);
  });

  test("a user has at most one open shift, and each cashier has their own", () => {
    const { business, sell } = setup();
    business.addUser({ name: "سارة", role: "cashier", password: "123456" });
    const sara = business.signIn("سارة", "123456");

    business.openShift(50_000);
    expect(() => business.openShift(0)).toThrow(expect.objectContaining({ code: "shift_already_open" }));
    expect(sara.currentShift()).toBeNull();
    expect(() => sell(sara, 1)).toThrow(expect.objectContaining({ code: "shift_required" }));
    sara.openShift(20_000);
    sell(sara, 2);

    expect(sara.currentShift()).toEqual(expect.objectContaining({ userName: "سارة", openingFloat: 20_000, status: "open" }));
    expect(business.zReport(sara.currentShift()!.id).sales.total).toBe(11_400);
    expect(business.zReport(business.currentShift()!.id).sales.total).toBe(0);
  });

  test("cash in and out post against the chosen account", () => {
    const { business, account } = setup();
    business.openShift(50_000);

    business.cashInOut({ date: "2026-11-20", direction: "out", amount: 3_000, accountId: account("owner_drawings"), reason: "سحب صاحب المحل" });
    business.cashInOut({ date: "2026-11-20", direction: "in", amount: 10_000, accountId: account("bank"), reason: "فكة من البنك" });

    expect(balanceOf(business, account("owner_drawings"))).toBe(3_000);
    expect(balanceOf(business, account("bank"))).toBe(-10_000);
    expect(balanceOf(business, account("cash_drawer"))).toBe(7_000);
    expect(() => business.cashInOut({ date: "2026-11-20", direction: "out", amount: 0, accountId: account("bank"), reason: "" })).toThrow(
      expect.objectContaining({ code: "line_amount_invalid" }),
    );
    expect(() =>
      business.cashInOut({ date: "2026-11-20", direction: "out", amount: 100, accountId: account("cash_drawer"), reason: "" }),
    ).toThrow(expect.objectContaining({ code: "account_not_allowed" }));
  });

  test("closing with a shortage posts cash short; the Z report shows every figure", () => {
    const { business, account, sell } = setup();
    business.openShift(50_000);
    sell(business, 3, 20_000);
    sell(business, 1);
    business.cashInOut({ date: "2026-11-20", direction: "out", amount: 3_000, accountId: account("owner_drawings"), reason: "سحب" });

    // Expected: 500.00 float + 228.00 sales − 30.00 out = 698.00. Counted 695.50.
    const z = business.closeShift({ date: "2026-11-20", countedCash: 69_550 });

    expect(z).toEqual(
      expect.objectContaining({
        receipts: 2,
        sales: { total: 22_800, net: 20_000, vat: 2_800, byMethod: { cash: 22_800, card: 0, wallet: 0, credit: 0 } },
        returns: 0,
        discounts: 0,
        cashIn: 0,
        cashOut: 3_000,
        openingFloat: 50_000,
        expectedCash: 69_800,
        countedCash: 69_550,
        difference: -250,
      }),
    );
    expect(z.shift.status).toBe("closed");
    expect(balanceOf(business, account("cash_short"))).toBe(250);
    expect(balanceOf(business, account("cash_drawer"))).toBe(22_800 - 3_000 - 250);
  });

  test("closing with extra cash posts cash over; an exact count posts nothing", () => {
    const { business, account, sell } = setup();
    business.openShift(0);
    sell(business, 1);
    business.closeShift({ date: "2026-11-20", countedCash: 5_800 });
    expect(balanceOf(business, account("cash_over"))).toBe(-100);

    business.openShift(0);
    sell(business, 1);
    const entriesBefore = business.trialBalance("2026-12-31").totalDebit;
    business.closeShift({ date: "2026-11-20", countedCash: 5_700 });
    expect(business.trialBalance("2026-12-31").totalDebit).toBe(entriesBefore);
  });

  test("a closed shift cannot change, and closing needs an open shift", () => {
    const { business, account, sell } = setup();
    const id = business.openShift(0);
    business.closeShift({ date: "2026-11-20", countedCash: 0 });

    expect(() => business.closeShift({ date: "2026-11-20", countedCash: 0 })).toThrow(expect.objectContaining({ code: "shift_required" }));
    expect(() => sell(business, 1)).toThrow(expect.objectContaining({ code: "shift_required" }));
    expect(() => business.cashInOut({ date: "2026-11-20", direction: "in", amount: 100, accountId: account("bank"), reason: "" })).toThrow(
      expect.objectContaining({ code: "shift_required" }),
    );
    expect(business.zReport(id).shift.status).toBe("closed");
    expect(business.shifts().map((s) => s.id)).toEqual([id]);
  });

  test("a storekeeper may not open a shift", () => {
    const { business } = setup();
    business.addUser({ name: "محمود", role: "storekeeper", password: "123456" });

    expect(() => business.signIn("محمود", "123456").openShift(0)).toThrow(expect.objectContaining({ code: "not_allowed" }));
  });
});
