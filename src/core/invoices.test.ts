import { describe, expect, test } from "vitest";
import { Business } from "./business";

const manager = { name: "أيمن", password: "كلمة سر قوية" };
const shop = { name: "شركة النور للكمبيوتر", address: "الدقي", taxRegistrationNumber: "123456789", vatRegistered: true, fiscalYearStartMonth: 1 };

function setup() {
  const business = Business.create(":memory:", shop, manager);
  const main = business.warehouses()[0]!.id;
  const codes = business.taxCodes();
  const standard = codes.find((c) => c.kind === "standard")!.id;
  const exempt = codes.find((c) => c.kind === "exempt")!.id;
  const router = business.addItem({ nameAr: "راوتر", baseUnit: "قطعة", salePrice: 150_000, taxCodeId: standard });
  const book = business.addItem({ nameAr: "كتاب", baseUnit: "قطعة", salePrice: 5_000, taxCodeId: exempt });
  const supplier = business.addSupplier({ name: "شركة الشبكات المتحدة", phone: "", taxRegistrationNumber: "" });
  const purchase = business.postPurchaseInvoice({
    date: "2026-01-02",
    supplierId: supplier,
    warehouseId: main,
    reference: "S-77",
    lines: [
      { itemId: router, unit: "base", quantity: 10_000, unitPrice: 100_000 },
      { itemId: book, unit: "base", quantity: 10_000, unitPrice: 3_000 },
    ],
  });
  const customer = business.addCustomer({ name: "شركة الأمل للتجارة", phone: "", taxRegistrationNumber: "987654321", address: "مدينة نصر" });
  return { business, main, router, book, supplier, purchase, customer };
}

function balanceOf(business: Business, role: string, asOf = "2026-12-31") {
  const account = business.accounts().find((a) => a.role === role)!;
  const row = business.trialBalance(asOf).rows.find((r) => r.accountId === account.id);
  return row ? row.debit - row.credit : 0;
}

function invoice(s: ReturnType<typeof setup>, date = "2026-02-01") {
  return s.business.postSalesInvoice({
    date,
    customerId: s.customer,
    warehouseId: s.main,
    reference: "PO-15",
    notes: "",
    lines: [
      { itemId: s.router, unit: "base", quantity: 2_000, unitPrice: 120_000, discount: 10_000 },
      { itemId: s.book, unit: "base", quantity: 3_000, unitPrice: 5_000 },
    ],
  });
}

describe("sales invoices", () => {
  test("an invoice prices VAT-exclusive lines, puts the total on the customer's account and issues stock at cost", () => {
    const s = setup();

    const posted = invoice(s);

    // Routers: 2 × 1,200.00 − 100.00 = 2,300.00 + 14% VAT 322.00; books: 3 × 50.00 = 150.00, exempt.
    expect(posted).toEqual({ id: expect.any(Number), number: 1, total: 277_200, belowZero: [] });
    expect(s.business.customerBalance(s.customer)).toBe(277_200);
    expect(balanceOf(s.business, "receivables")).toBe(277_200);
    expect(balanceOf(s.business, "sales")).toBe(-245_000);
    expect(balanceOf(s.business, "output_vat")).toBe(-32_200);
    expect(balanceOf(s.business, "cost_of_goods_sold")).toBe(209_000);
    expect(s.business.stockOnHand(s.router).total).toBe(8_000);

    const found = s.business.findSalesInvoice(1);
    expect(found).toEqual(
      expect.objectContaining({ customerName: "شركة الأمل للتجارة", reference: "PO-15", gross: 255_000, discount: 10_000, net: 245_000, vat: 32_200, total: 277_200, credited: 0 }),
    );
    expect(found.lines[0]).toEqual(
      expect.objectContaining({ nameAr: "راوتر", quantity: 2_000, unitPrice: 120_000, gross: 240_000, discount: 10_000, net: 230_000, vatRate: 1_400, vat: 32_200, credited: 0 }),
    );
    expect(invoice(s).number).toBe(2);
    expect(s.business.salesInvoices().map((i) => i.number)).toEqual([2, 1]);
  });

  test("an invoice needs an active customer, lines, a total and discounts that fit", () => {
    const s = setup();
    const base = { date: "2026-02-01", customerId: s.customer, warehouseId: s.main, reference: "", notes: "" };

    expect(() => s.business.postSalesInvoice({ ...base, lines: [] })).toThrow(expect.objectContaining({ code: "invoice_needs_lines" }));
    expect(() =>
      s.business.postSalesInvoice({ ...base, lines: [{ itemId: s.router, unit: "base", quantity: 1_000, unitPrice: 100, discount: 101 }] }),
    ).toThrow(expect.objectContaining({ code: "discount_invalid" }));
    expect(() =>
      s.business.postSalesInvoice({ ...base, lines: [{ itemId: s.router, unit: "base", quantity: 1_000, unitPrice: 0 }] }),
    ).toThrow(expect.objectContaining({ code: "invoice_total_zero" }));
    s.business.deactivateCustomer(s.customer);
    expect(() =>
      s.business.postSalesInvoice({ ...base, lines: [{ itemId: s.router, unit: "base", quantity: 1_000, unitPrice: 100 }] }),
    ).toThrow(expect.objectContaining({ code: "customer_inactive" }));
    expect(() => s.business.findSalesInvoice(9)).toThrow(expect.objectContaining({ code: "invoice_not_found" }));
  });

  test("a credit note takes goods back at the invoice's price, VAT and cost, and the last piece takes what is left", () => {
    const s = setup();
    const posted = invoice(s);
    const routerLine = s.business.findSalesInvoice(1).lines[0]!.lineId;

    const first = s.business.postCreditNote({ date: "2026-02-05", invoiceId: posted.id, reason: "عيب صناعة", lines: [{ lineId: routerLine, quantity: 1_000 }] });

    expect(first).toEqual({ id: expect.any(Number), number: 1, total: 131_100 });
    expect(s.business.customerBalance(s.customer)).toBe(277_200 - 131_100);
    expect(s.business.stockOnHand(s.router).total).toBe(9_000);
    expect(balanceOf(s.business, "cost_of_goods_sold")).toBe(109_000);
    expect(s.business.findCreditNote(1)).toEqual(
      expect.objectContaining({ invoiceNumber: 1, customerName: "شركة الأمل للتجارة", reason: "عيب صناعة", net: 115_000, vat: 16_100, total: 131_100 }),
    );

    s.business.postCreditNote({ date: "2026-02-06", invoiceId: posted.id, reason: "", lines: [{ lineId: routerLine, quantity: 1_000 }] });

    const after = s.business.findSalesInvoice(1);
    expect(after.credited).toBe(262_200);
    expect(after.lines[0]!.credited).toBe(2_000);
    expect(after.creditNotes.map((n) => n.number)).toEqual([1, 2]);
    expect(balanceOf(s.business, "output_vat")).toBe(0);
    expect(() =>
      s.business.postCreditNote({ date: "2026-02-07", invoiceId: posted.id, reason: "", lines: [{ lineId: routerLine, quantity: 1 }] }),
    ).toThrow(expect.objectContaining({ code: "return_exceeds_sale" }));
  });
});

describe("supplier debit notes", () => {
  test("goods go back to the supplier at the invoice's cost and VAT, lowering what is owed", () => {
    const s = setup();
    const line = s.business.purchaseInvoices()[0]!.lines[0]!;

    const note = s.business.postDebitNote({ date: "2026-01-10", purchaseInvoiceId: s.purchase, reason: "تالف", lines: [{ lineId: line.lineId, quantity: 3_000 }] });

    // 3 × 1,000.00 + 14% VAT.
    expect(note).toEqual({ id: expect.any(Number), number: 1, total: 342_000 });
    expect(s.business.supplierBalance(s.supplier)).toBe(1_140_000 + 30_000 - 342_000);
    expect(s.business.stockOnHand(s.router).total).toBe(7_000);
    expect(s.business.stockValue(s.router)).toBe(700_000);
    expect(balanceOf(s.business, "input_vat")).toBe(140_000 - 42_000);
    expect(s.business.purchaseInvoices()[0]!.lines[0]!.returned).toBe(3_000);
    expect(s.business.debitNotes()[0]).toEqual(expect.objectContaining({ number: 1, supplierId: s.supplier, reason: "تالف", total: 342_000 }));
    expect(() =>
      s.business.postDebitNote({ date: "2026-01-10", purchaseInvoiceId: s.purchase, reason: "", lines: [{ lineId: line.lineId, quantity: 7_001 }] }),
    ).toThrow(expect.objectContaining({ code: "return_exceeds_sale" }));
  });
});

describe("customer and supplier details", () => {
  test("customers carry an address, a price level and an optional credit limit", () => {
    const s = setup();

    s.business.updateCustomer(s.customer, { priceLevel: "wholesale", creditLimit: 5_000_000 });

    expect(s.business.customers()[0]).toEqual(
      expect.objectContaining({ address: "مدينة نصر", priceLevel: "wholesale", creditLimit: 5_000_000, taxRegistrationNumber: "987654321" }),
    );
    s.business.updateCustomer(s.customer, { creditLimit: null });
    expect(s.business.customers()[0]!.creditLimit).toBeNull();
    expect(() => s.business.updateCustomer(s.customer, { creditLimit: -1 })).toThrow(expect.objectContaining({ code: "credit_limit_invalid" }));
  });

  test("a supplier's currency is fixed once they have postings, and a foreign invoice needs a rate", () => {
    const s = setup();
    const importer = s.business.addSupplier({ name: "Shenzhen Tech", phone: "", taxRegistrationNumber: "", currency: "USD" });

    expect(s.business.suppliers().find((x) => x.id === importer)!.currency).toBe("USD");
    expect(() =>
      s.business.postPurchaseInvoice({ date: "2026-01-05", supplierId: importer, warehouseId: s.main, reference: "", lines: [{ itemId: s.router, unit: "base", quantity: 1_000, unitPrice: 100 }] }),
    ).toThrow(expect.objectContaining({ code: "rate_invalid" }));
    expect(() => s.business.updateSupplier(s.supplier, { currency: "EUR" })).toThrow(expect.objectContaining({ code: "supplier_currency_locked" }));
    expect(s.business.suppliers().find((x) => x.id === s.supplier)!.currency).toBe("EGP");
  });
});
