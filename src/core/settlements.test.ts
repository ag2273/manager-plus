import { describe, expect, test } from "vitest";
import { Business } from "./business";

const manager = { name: "أيمن", password: "كلمة سر قوية" };
const shop = { name: "شركة النور للكمبيوتر", address: "الدقي", taxRegistrationNumber: "", vatRegistered: true, fiscalYearStartMonth: 1 };

function setup() {
  const business = Business.create(":memory:", shop, manager);
  const main = business.warehouses()[0]!.id;
  const standard = business.taxCodes().find((c) => c.kind === "standard")!.id;
  const router = business.addItem({ nameAr: "راوتر", baseUnit: "قطعة", salePrice: 150_000, taxCodeId: standard });
  const supplier = business.addSupplier({ name: "شركة الشبكات المتحدة", phone: "", taxRegistrationNumber: "" });
  business.postPurchaseInvoice({
    date: "2026-01-02",
    supplierId: supplier,
    warehouseId: main,
    reference: "S-77",
    lines: [{ itemId: router, unit: "base", quantity: 20_000, unitPrice: 100_000 }],
  });
  const amal = business.addCustomer({ name: "شركة الأمل", phone: "", taxRegistrationNumber: "" });
  const nour = business.addCustomer({ name: "مكتب النور", phone: "", taxRegistrationNumber: "" });
  const account = (role: string) => business.accounts().find((a) => a.role === role)!.id;
  /** An invoice of `routers` at 1,000.00 + 14% VAT = 1,140.00 each. */
  const sell = (customerId: number, date: string, routers: number) =>
    business.postSalesInvoice({
      date,
      customerId,
      warehouseId: main,
      reference: "",
      notes: "",
      lines: [{ itemId: router, unit: "base", quantity: routers * 1_000, unitPrice: 100_000 }],
    });
  return { business, main, router, supplier, amal, nour, account, sell };
}

function balanceOf(business: Business, role: string, asOf = "2026-12-31") {
  const account = business.accounts().find((a) => a.role === role)!;
  const row = business.trialBalance(asOf).rows.find((r) => r.accountId === account.id);
  return row ? row.debit - row.credit : 0;
}

describe("payments", () => {
  test("a customer payment goes into the bank and off their account, settling the invoice it names", () => {
    const s = setup();
    s.sell(s.amal, "2026-02-01", 1);
    const second = s.sell(s.amal, "2026-02-10", 2);
    const [, secondDoc] = s.business.openDocuments("customer", s.amal);

    const paid = s.business.receiveCustomerPayment({
      date: "2026-02-15",
      partyId: s.amal,
      accountId: s.account("bank"),
      amount: 200_000,
      reference: "شيك 4411",
      allocations: [{ entryId: secondDoc!.entryId, amount: 200_000 }],
    });

    expect(paid).toEqual({ id: expect.any(Number), number: 1 });
    expect(second.total).toBe(228_000);
    expect(s.business.customerBalance(s.amal)).toBe(114_000 + 228_000 - 200_000);
    expect(balanceOf(s.business, "bank")).toBe(200_000);
    expect(s.business.openDocuments("customer", s.amal).map((d) => [d.amount, d.open])).toEqual([
      [114_000, 114_000],
      [228_000, 28_000],
    ]);
    expect(s.business.receiveCustomerPayment({ date: "2026-02-16", partyId: s.nour, accountId: s.account("main_cash"), amount: 100, reference: "" }).number).toBe(2);
  });

  test("a supplier payment comes out of the cash box and off what is owed to them", () => {
    const s = setup();

    const paid = s.business.paySupplier({ date: "2026-01-20", partyId: s.supplier, accountId: s.account("main_cash"), amount: 1_000_000, reference: "" });

    expect(paid.number).toBe(1);
    expect(s.business.supplierBalance(s.supplier)).toBe(2_280_000 - 1_000_000);
    expect(balanceOf(s.business, "main_cash")).toBe(-1_000_000);
    expect(balanceOf(s.business, "payables")).toBe(-1_280_000);
  });

  test("a payment needs a money account, a positive amount, and allocations that fit", () => {
    const s = setup();
    s.sell(s.amal, "2026-02-01", 1);
    const [doc] = s.business.openDocuments("customer", s.amal);
    const base = { date: "2026-02-15", partyId: s.amal, accountId: s.account("bank"), amount: 100_000, reference: "" };

    expect(() => s.business.receiveCustomerPayment({ ...base, accountId: s.account("stock") })).toThrow(expect.objectContaining({ code: "account_not_allowed" }));
    expect(() => s.business.receiveCustomerPayment({ ...base, amount: 0 })).toThrow(expect.objectContaining({ code: "amount_invalid" }));
    expect(() => s.business.receiveCustomerPayment({ ...base, allocations: [{ entryId: doc!.entryId, amount: 100_001 }] })).toThrow(
      expect.objectContaining({ code: "allocation_invalid" }),
    );
    expect(() => s.business.receiveCustomerPayment({ ...base, amount: 500_000, allocations: [{ entryId: doc!.entryId, amount: 114_001 }] })).toThrow(
      expect.objectContaining({ code: "allocation_invalid" }),
    );
    expect(s.business.customerBalance(s.amal)).toBe(114_000);
  });
});

describe("statements", () => {
  test("a statement shows the balance brought forward, each posting with a running balance, and the balance at the end", () => {
    const s = setup();
    s.sell(s.amal, "2026-01-15", 1);
    const invoice = s.sell(s.amal, "2026-02-01", 2);
    s.business.receiveCustomerPayment({ date: "2026-02-10", partyId: s.amal, accountId: s.account("bank"), amount: 100_000, reference: "" });
    const line = s.business.findSalesInvoice(invoice.number).lines[0]!.lineId;
    s.business.postCreditNote({ date: "2026-02-12", invoiceId: invoice.id, reason: "", lines: [{ lineId: line, quantity: 1_000 }] });
    s.sell(s.amal, "2026-03-01", 1);

    const february = s.business.statement("customer", s.amal, "2026-02-01", "2026-02-28");

    expect(february.opening).toBe(114_000);
    expect(february.lines.map((l) => [l.date, l.debit, l.credit, l.balance])).toEqual([
      ["2026-02-01", 228_000, 0, 342_000],
      ["2026-02-10", 0, 100_000, 242_000],
      ["2026-02-12", 0, 114_000, 128_000],
    ]);
    expect(february.lines.map((l) => l.memo)).toEqual(["فاتورة مبيعات رقم 2 - شركة الأمل", "سند قبض رقم 1 من شركة الأمل", "إشعار دائن رقم 1 على فاتورة 2"]);
    expect(february.closing).toBe(128_000);
    expect(() => s.business.statement("customer", s.amal, "2026-03-01", "2026-02-01")).toThrow(expect.objectContaining({ code: "date_range_invalid" }));
  });

  test("a supplier statement counts what the business owes as the balance", () => {
    const s = setup();
    s.business.paySupplier({ date: "2026-01-20", partyId: s.supplier, accountId: s.account("bank"), amount: 280_000, reference: "" });

    const all = s.business.statement("supplier", s.supplier, "2026-01-01", "2026-12-31");

    expect(all.opening).toBe(0);
    expect(all.lines.map((l) => [l.debit, l.credit, l.balance])).toEqual([
      [0, 2_280_000, 2_280_000],
      [280_000, 0, 2_000_000],
    ]);
    expect(all.closing).toBe(s.business.supplierBalance(s.supplier));
  });
});

describe("aging", () => {
  test("open invoices fall into 0–30, 31–60, 61–90 and over 90 days; unallocated money settles the oldest first", () => {
    const s = setup();
    s.sell(s.amal, "2026-01-10", 1); // 111 days old on 1 May
    s.sell(s.amal, "2026-03-15", 1); // 47 days
    const recent = s.sell(s.amal, "2026-04-25", 2); // 6 days
    s.sell(s.nour, "2026-02-20", 1); // 70 days
    const [, , recentDoc] = s.business.openDocuments("customer", s.amal);
    s.business.receiveCustomerPayment({
      date: "2026-04-28",
      partyId: s.amal,
      accountId: s.account("bank"),
      amount: 300_000,
      reference: "",
      allocations: [{ entryId: recentDoc!.entryId, amount: 100_000 }],
    });

    const report = s.business.aging("customer", "2026-05-01");

    // 100.00 settles part of the recent invoice; the other 2,000.00 clears the January invoice and 860.00 of March's.
    expect(recent.total).toBe(228_000);
    expect(report.rows).toEqual([
      { partyId: s.amal, name: "شركة الأمل", buckets: [128_000, 28_000, 0, 0], unapplied: 0, balance: 156_000 },
      { partyId: s.nour, name: "مكتب النور", buckets: [0, 0, 114_000, 0], unapplied: 0, balance: 114_000 },
    ]);
    expect(report.totals).toEqual([128_000, 28_000, 114_000, 0]);
    expect(report.balance).toBe(balanceOf(s.business, "receivables"));
  });

  test("money paid ahead of any invoice shows as unapplied, and documents after the date are left out", () => {
    const s = setup();
    s.business.receiveCustomerPayment({ date: "2026-01-05", partyId: s.nour, accountId: s.account("main_cash"), amount: 50_000, reference: "" });
    s.sell(s.nour, "2026-06-01", 1);

    const report = s.business.aging("customer", "2026-05-01");

    expect(report.rows).toEqual([{ partyId: s.nour, name: "مكتب النور", buckets: [0, 0, 0, 0], unapplied: 50_000, balance: -50_000 }]);
  });

  test("aged payables age the supplier's invoices less debit notes and payments", () => {
    const s = setup();
    const purchase = s.business.purchaseInvoices()[0]!;
    s.business.postDebitNote({ date: "2026-01-05", purchaseInvoiceId: purchase.id, reason: "", lines: [{ lineId: purchase.lines[0]!.lineId, quantity: 2_000 }] });
    s.business.paySupplier({ date: "2026-01-20", partyId: s.supplier, accountId: s.account("bank"), amount: 1_000_000, reference: "" });

    const report = s.business.aging("supplier", "2026-02-15");

    expect(report.rows).toEqual([{ partyId: s.supplier, name: "شركة الشبكات المتحدة", buckets: [0, 1_052_000, 0, 0], unapplied: 0, balance: 1_052_000 }]);
    expect(report.balance).toBe(-balanceOf(s.business, "payables"));
  });
});

describe("invariants", () => {
  test("the receivables and payables accounts always equal the sum of the parties' balances", () => {
    const s = setup();
    const first = s.sell(s.amal, "2026-02-01", 3);
    s.sell(s.nour, "2026-02-02", 1);
    s.business.openShift(0);
    s.business.postSale({ date: "2026-02-03", warehouseId: s.main, lines: [{ itemId: s.router, unit: "base", quantity: 1_000 }], payments: [], customerId: s.nour });
    s.business.receiveCustomerPayment({ date: "2026-02-05", partyId: s.amal, accountId: s.account("bank"), amount: 200_000, reference: "" });
    const line = s.business.findSalesInvoice(first.number).lines[0]!.lineId;
    s.business.postCreditNote({ date: "2026-02-06", invoiceId: first.id, reason: "", lines: [{ lineId: line, quantity: 1_000 }] });
    s.business.paySupplier({ date: "2026-02-07", partyId: s.supplier, accountId: s.account("main_cash"), amount: 500_000, reference: "" });
    const purchase = s.business.purchaseInvoices()[0]!;
    s.business.postDebitNote({ date: "2026-02-08", purchaseInvoiceId: purchase.id, reason: "", lines: [{ lineId: purchase.lines[0]!.lineId, quantity: 1_000 }] });

    const customers = s.business.customers().reduce((t, c) => t + s.business.customerBalance(c.id), 0);
    const suppliers = s.business.suppliers().reduce((t, x) => t + s.business.supplierBalance(x.id), 0);

    expect(customers).toBe(balanceOf(s.business, "receivables"));
    expect(customers).toBe(s.business.aging("customer", "2026-12-31").balance);
    expect(suppliers).toBe(-balanceOf(s.business, "payables"));
    expect(suppliers).toBe(s.business.aging("supplier", "2026-12-31").balance);
    const tb = s.business.trialBalance("2026-12-31");
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });
});
