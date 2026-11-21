import { describe, expect, test } from "vitest";
import { Business } from "./business";
import { toEgp } from "./currency";

const manager = { name: "أيمن", password: "كلمة سر قوية" };
const shop = { name: "شركة النور للاستيراد", address: "", taxRegistrationNumber: "", vatRegistered: true, fiscalYearStartMonth: 1 };

function setup() {
  const business = Business.create(":memory:", shop, manager);
  const main = business.warehouses()[0]!.id;
  const standard = business.taxCodes().find((c) => c.kind === "standard")!.id;
  const router = business.addItem({ nameAr: "راوتر", baseUnit: "قطعة", salePrice: 600_000, taxCodeId: standard });
  const shenzhen = business.addSupplier({ name: "Shenzhen Networks", phone: "", taxRegistrationNumber: "", currency: "USD" });
  const local = business.addSupplier({ name: "مورد محلي", phone: "", taxRegistrationNumber: "" });
  const account = (role: string) => business.accounts().find((a) => a.role === role)!.id;
  /** Routers at USD 100.00 each. */
  const buy = (routers: number, rate: number, date = "2026-02-01") =>
    business.postPurchaseInvoice({
      date,
      supplierId: shenzhen,
      warehouseId: main,
      reference: "SZ-1",
      rate,
      lines: [{ itemId: router, unit: "base", quantity: routers * 1_000, unitPrice: 10_000 }],
    });
  const pay = (amount: number, rate: number, allocations?: { entryId: number; amount: number }[]) =>
    business.paySupplier({ date: "2026-03-01", partyId: shenzhen, accountId: account("bank"), amount, rate, reference: "", ...(allocations ? { allocations } : {}) });
  return { business, main, router, shenzhen, local, account, buy, pay };
}

function balanceOf(business: Business, role: string) {
  const account = business.accounts().find((a) => a.role === role)!;
  const row = business.trialBalance("2026-12-31").rows.find((r) => r.accountId === account.id);
  return row ? row.debit - row.credit : 0;
}

describe("foreign-currency suppliers", () => {
  test("converts to piastres exactly, rounding half up", () => {
    expect(toEgp(100_000, 48_500_000)).toBe(4_850_000);
    expect(toEgp(1, 48_505_000)).toBe(49); // 0.485050 EGP
    expect(toEgp(1, 48_495_000)).toBe(48);
    expect(toEgp(900_000_000_000, 52_123_456)).toBe(46_911_110_400_000);
  });

  test("USD 1,000 bought at 48.50 and paid at 49.20 posts an exchange loss of EGP 700.00", () => {
    const s = setup();
    s.buy(10, 48_500_000);
    expect(balanceOf(s.business, "stock")).toBe(4_850_000);
    expect(balanceOf(s.business, "input_vat")).toBe(0);
    expect(s.business.supplierAccount(s.shenzhen)).toEqual({ currency: "USD", owed: 100_000, owedEgp: 4_850_000 });
    const [invoice] = s.business.openDocuments("supplier", s.shenzhen);
    expect(invoice).toEqual(expect.objectContaining({ amount: 100_000, open: 100_000 }));

    s.pay(100_000, 49_200_000, [{ entryId: invoice!.entryId, amount: 100_000 }]);

    expect(balanceOf(s.business, "bank")).toBe(-4_920_000);
    expect(balanceOf(s.business, "exchange_loss")).toBe(70_000);
    expect(balanceOf(s.business, "payables")).toBe(0);
    expect(s.business.supplierAccount(s.shenzhen)).toEqual({ currency: "USD", owed: 0, owedEgp: 0 });
    expect(s.business.openDocuments("supplier", s.shenzhen)).toEqual([]);
  });

  test("a payment at a lower rate is a gain, and part payments leave nothing behind once the invoice is settled", () => {
    const s = setup();
    s.buy(3, 48_333_333); // USD 300 = EGP 14,500.00 (14,499.9999)
    expect(s.business.supplierAccount(s.shenzhen).owedEgp).toBe(1_450_000);
    s.pay(10_000, 47_000_000); // USD 100 at 47 (carrying 4,833.33)
    s.pay(20_000, 47_000_000); // USD 200 at 47 (carrying the rest, 9,666.67)
    expect(balanceOf(s.business, "exchange_gain")).toBe(-(1_450_000 - 1_410_000));
    expect(balanceOf(s.business, "payables")).toBe(0);
    expect(s.business.supplierAccount(s.shenzhen)).toEqual({ currency: "USD", owed: 0, owedEgp: 0 });
  });

  test("an unallocated payment settles the oldest invoices first, each at its own rate", () => {
    const s = setup();
    s.buy(1, 48_000_000, "2026-01-10");
    s.buy(1, 50_000_000, "2026-01-20");
    s.pay(15_000, 49_000_000); // USD 100 of the first, USD 50 of the second
    // carrying 4,800 + 2,500 = 7,300; paid 7,350 → loss 50
    expect(balanceOf(s.business, "exchange_loss")).toBe(5_000);
    expect(s.business.openDocuments("supplier", s.shenzhen).map((d) => d.open)).toEqual([5_000]);
    expect(s.business.supplierAccount(s.shenzhen)).toEqual({ currency: "USD", owed: 5_000, owedEgp: 250_000 });
  });

  test("money paid before any invoice is an advance at its own rate", () => {
    const s = setup();
    s.pay(10_000, 49_000_000);
    expect(balanceOf(s.business, "exchange_loss")).toBe(0);
    expect(s.business.supplierAccount(s.shenzhen)).toEqual({ currency: "USD", owed: -10_000, owedEgp: -490_000 });
  });

  test("goods sent back go at the invoice's rate, and the statement is in the supplier's currency", () => {
    const s = setup();
    const id = s.buy(10, 48_500_000);
    const line = s.business.purchaseInvoices().find((p) => p.id === id)!.lines[0]!;
    expect(s.business.purchaseInvoices()[0]).toEqual(expect.objectContaining({ currency: "USD", rate: 48_500_000, total: 100_000, totalEgp: 4_850_000 }));
    s.business.postDebitNote({ date: "2026-02-05", purchaseInvoiceId: id, reason: "تالف", lines: [{ lineId: line.lineId, quantity: 2_000 }] });
    expect(balanceOf(s.business, "stock")).toBe(4_850_000 - 970_000);
    expect(s.business.supplierAccount(s.shenzhen)).toEqual({ currency: "USD", owed: 80_000, owedEgp: 3_880_000 });
    const statement = s.business.statement("supplier", s.shenzhen, "2026-01-01", "2026-12-31");
    expect(statement.currency).toBe("USD");
    expect(statement.lines.map((l) => [l.debit, l.credit])).toEqual([
      [0, 100_000],
      [20_000, 0],
    ]);
    expect(statement.closing).toBe(80_000);
  });

  test("a foreign document needs a rate, an EGP one takes none, and a supplier's currency is fixed once posted", () => {
    const s = setup();
    expect(() => s.buy(1, 0)).toThrow(expect.objectContaining({ code: "rate_invalid" }));
    expect(() =>
      s.business.postPurchaseInvoice({ date: "2026-02-01", supplierId: s.shenzhen, warehouseId: s.main, reference: "", lines: [{ itemId: s.router, unit: "base", quantity: 1_000, unitPrice: 1 }] }),
    ).toThrow(expect.objectContaining({ code: "rate_invalid" }));
    expect(() =>
      s.business.postPurchaseInvoice({ date: "2026-02-01", supplierId: s.local, warehouseId: s.main, reference: "", rate: 48_000_000, lines: [{ itemId: s.router, unit: "base", quantity: 1_000, unitPrice: 1 }] }),
    ).toThrow(expect.objectContaining({ code: "rate_invalid" }));
    s.buy(1, 48_000_000);
    expect(() => s.business.updateSupplier(s.shenzhen, { currency: "EUR" })).toThrow(expect.objectContaining({ code: "supplier_currency_locked" }));
    expect(s.business.pricePurchase("2026-02-01", [{ itemId: s.router, unit: "base", quantity: 1_000, unitPrice: 10_000 }], { currency: "USD", rate: 48_000_000 })).toEqual(
      expect.objectContaining({ net: 10_000, vat: 0, total: 10_000, totalEgp: 480_000 }),
    );
  });
});
