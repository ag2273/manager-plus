import { describe, expect, test } from "vitest";
import { Business } from "./business";

const manager = { name: "أيمن", password: "كلمة سر قوية" };
const shop = { name: "شركة النور للكمبيوتر", address: "", taxRegistrationNumber: "", vatRegistered: true, fiscalYearStartMonth: 1 };

function setup() {
  const business = Business.create(":memory:", shop, manager);
  const main = business.warehouses()[0]!.id;
  const standard = business.taxCodes().find((c) => c.kind === "standard")!.id;
  const category = (rate: number) => business.withholdingCategories().find((c) => c.rates.at(-1)!.rate === rate)!.id;
  const supplies = category(100);
  const services = category(300);
  const router = business.addItem({ nameAr: "راوتر", baseUnit: "قطعة", salePrice: 150_000, taxCodeId: standard });
  const supplier = business.addSupplier({
    name: "شركة الشبكات المتحدة",
    phone: "",
    taxRegistrationNumber: "123456789",
    withholdingCategoryId: supplies,
  });
  // 10 routers at 1,000.00 + 14% VAT: the supplier is owed 11,400.00.
  business.postPurchaseInvoice({
    date: "2026-01-02",
    supplierId: supplier,
    warehouseId: main,
    reference: "",
    lines: [{ itemId: router, unit: "base", quantity: 10_000, unitPrice: 100_000 }],
  });
  const amal = business.addCustomer({ name: "شركة الأمل", phone: "", taxRegistrationNumber: "987654321", withholdingCategoryId: supplies });
  business.postSalesInvoice({
    date: "2026-02-01",
    customerId: amal,
    warehouseId: main,
    reference: "",
    notes: "",
    lines: [{ itemId: router, unit: "base", quantity: 5_000, unitPrice: 150_000 }],
  });
  const account = (role: string) => business.accounts().find((a) => a.role === role)!.id;
  return { business, supplies, services, supplier, amal, account };
}

function balanceOf(business: Business, role: string) {
  const account = business.accounts().find((a) => a.role === role)!;
  const row = business.trialBalance("2026-12-31").rows.find((r) => r.accountId === account.id);
  return row ? row.debit - row.credit : 0;
}

describe("withholding tax", () => {
  test("categories come with dated rates of 1%, 3% and 5%, and a new rate takes over from its date", () => {
    const s = setup();
    expect(s.business.withholdingCategories().map((c) => c.rates.at(-1)!.rate)).toEqual([100, 300, 500]);
    expect(s.business.withholdingTax(s.services, "2026-03-01", 1_000_000)).toBe(30_000);

    s.business.addWithholdingRate(s.services, { from: "2026-07-01", rate: 200 });
    expect(s.business.withholdingTax(s.services, "2026-06-30", 1_000_000)).toBe(30_000);
    expect(s.business.withholdingTax(s.services, "2026-07-01", 1_000_000)).toBe(20_000);
    expect(() => s.business.addWithholdingRate(s.services, { from: "2026-07-01", rate: 10_001 })).toThrow(
      expect.objectContaining({ code: "tax_rate_invalid" }),
    );
    expect(() => s.business.withholdingTax(999, "2026-07-01", 1)).toThrow(expect.objectContaining({ code: "withholding_category_not_found" }));
  });

  test("parties carry a default category", () => {
    const s = setup();
    expect(s.business.suppliers().find((x) => x.id === s.supplier)!.withholdingCategoryId).toBe(s.supplies);
    s.business.updateCustomer(s.amal, { withholdingCategoryId: null });
    expect(s.business.customers().find((x) => x.id === s.amal)!.withholdingCategoryId).toBeNull();
    expect(() => s.business.updateSupplier(s.supplier, { withholdingCategoryId: 999 })).toThrow(
      expect.objectContaining({ code: "withholding_category_not_found" }),
    );
  });

  test("paying a supplier: the full amount off their account, the net out of the cash, the tax owed to the authority", () => {
    const s = setup();
    // 1% of the 10,000.00 before VAT is 100.00; the supplier gets 11,300.00.
    s.business.paySupplier({
      date: "2026-01-20",
      partyId: s.supplier,
      accountId: s.account("main_cash"),
      amount: 1_140_000,
      reference: "",
      withholding: { categoryId: s.supplies, base: 1_000_000 },
    });
    expect(s.business.supplierBalance(s.supplier)).toBe(0);
    expect(balanceOf(s.business, "main_cash")).toBe(-1_130_000);
    expect(balanceOf(s.business, "withholding_payable")).toBe(-10_000);
  });

  test("a company customer paying us: the net into the bank, the tax held as a credit, the full amount off their account", () => {
    const s = setup();
    // 5 routers at 1,500.00 + VAT = 8,550.00; 1% of 7,500.00 is 75.00.
    s.business.receiveCustomerPayment({
      date: "2026-02-10",
      partyId: s.amal,
      accountId: s.account("bank"),
      amount: 855_000,
      reference: "",
      withholding: { categoryId: s.supplies, base: 750_000 },
    });
    expect(s.business.customerBalance(s.amal)).toBe(0);
    expect(balanceOf(s.business, "bank")).toBe(847_500);
    expect(balanceOf(s.business, "withholding_receivable")).toBe(7_500);
  });

  test("the report lists both directions for the period, with tax registration numbers", () => {
    const s = setup();
    const pay = { accountId: s.account("bank"), reference: "" };
    s.business.paySupplier({
      ...pay,
      date: "2026-01-20",
      partyId: s.supplier,
      amount: 1_140_000,
      withholding: { categoryId: s.supplies, base: 1_000_000 },
    });
    s.business.receiveCustomerPayment({
      ...pay,
      date: "2026-02-10",
      partyId: s.amal,
      amount: 400_000,
      withholding: { categoryId: s.services, base: 300_000 },
    });
    s.business.receiveCustomerPayment({ ...pay, date: "2026-02-11", partyId: s.amal, amount: 100_000 });
    s.business.receiveCustomerPayment({
      ...pay,
      date: "2026-04-02",
      partyId: s.amal,
      amount: 100_000,
      withholding: { categoryId: s.supplies, base: 80_000 },
    });

    const report = s.business.withholdingReport("2026-01-01", "2026-03-31");
    expect(report.rows.map((r) => [r.kind, r.date, r.partyName, r.taxRegistrationNumber, r.rate, r.base, r.tax])).toEqual([
      ["supplier", "2026-01-20", "شركة الشبكات المتحدة", "123456789", 100, 1_000_000, 10_000],
      ["customer", "2026-02-10", "شركة الأمل", "987654321", 300, 300_000, 9_000],
    ]);
    expect(report.rows[0]!.category).toBe(s.business.withholdingCategories()[0]!.name);
    expect(report.withheld).toBe(10_000);
    expect(report.suffered).toBe(9_000);
    expect(() => s.business.withholdingReport("2026-04-01", "2026-03-01")).toThrow(expect.objectContaining({ code: "date_range_invalid" }));
  });

  test("the tax must be less than the payment, and only on EGP", () => {
    const s = setup();
    const base = { date: "2026-02-10", partyId: s.amal, accountId: s.account("bank"), amount: 1_000, reference: "" };
    expect(() => s.business.receiveCustomerPayment({ ...base, withholding: { categoryId: s.services, base: 100_000 } })).toThrow(
      expect.objectContaining({ code: "withholding_invalid" }),
    );
    expect(() => s.business.receiveCustomerPayment({ ...base, withholding: { categoryId: s.services, base: -1 } })).toThrow(
      expect.objectContaining({ code: "withholding_invalid" }),
    );
    const usd = s.business.addSupplier({ name: "Shenzhen", phone: "", taxRegistrationNumber: "", currency: "USD" });
    expect(() => s.business.paySupplier({ ...base, partyId: usd, rate: 50_000_000, withholding: { categoryId: s.supplies, base: 100 } })).toThrow(
      expect.objectContaining({ code: "withholding_not_egp" }),
    );
  });
});
