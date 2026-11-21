import { describe, expect, test } from "vitest";
import { Business } from "./business";

const manager = { name: "أيمن", password: "كلمة سر قوية" };
const shop = { name: "شركة النور للكمبيوتر", address: "", taxRegistrationNumber: "", vatRegistered: true, fiscalYearStartMonth: 1 };

function setup() {
  const business = Business.create(":memory:", shop, manager);
  const main = business.warehouses()[0]!.id;
  const standard = business.taxCodes().find((c) => c.kind === "standard")!.id;
  // Shelf price 1,140 with VAT (1,000 + 14%), wholesale 912 with VAT (800 + 14%).
  const router = business.addItem({
    nameAr: "راوتر",
    baseUnit: "قطعة",
    salePrice: 114_000,
    wholesalePrice: 91_200,
    taxCodeId: standard,
    pack: { name: "كرتونة", size: 10_000, salePrice: 1_026_000, wholesalePrice: 855_000 },
  });
  const cable = business.addItem({ nameAr: "كابل", baseUnit: "متر", salePrice: 1_140, taxCodeId: standard });
  const amal = business.addCustomer({ name: "شركة الأمل", phone: "", taxRegistrationNumber: "", priceLevel: "wholesale" });
  const walkIn = business.addCustomer({ name: "عميل قطاعي", phone: "", taxRegistrationNumber: "" });
  const supplier = business.addSupplier({ name: "مورد", phone: "", taxRegistrationNumber: "" });
  business.postPurchaseInvoice({
    date: "2026-01-01",
    supplierId: supplier,
    warehouseId: main,
    reference: "",
    lines: [{ itemId: router, unit: "base", quantity: 50_000, unitPrice: 60_000 }],
  });
  const quote = (over: object = {}) =>
    business.saveQuotation({
      date: "2026-02-01",
      validUntil: "2026-02-15",
      customerId: amal,
      reference: "RFQ-9",
      notes: "الأسعار شاملة التركيب",
      lines: [{ itemId: router, unit: "base", quantity: 5_000, unitPrice: 80_000, discount: 10_000 }],
      ...over,
    });
  return { business, main, router, cable, amal, walkIn, quote };
}

const balanceOf = (business: Business) => business.trialBalance("2026-12-31").rows.map((r) => [r.code, r.debit, r.credit]);

describe("price levels", () => {
  test("a customer's level picks the retail or wholesale price, VAT taken off for the invoice line", () => {
    const s = setup();
    const item = s.business.items().find((i) => i.id === s.router)!;
    expect(item.wholesalePrice).toBe(91_200);
    expect(item.pack!.wholesalePrice).toBe(855_000);

    expect(s.business.listPrice(s.amal, s.router, "base", "2026-02-01")).toBe(80_000);
    expect(s.business.listPrice(s.walkIn, s.router, "base", "2026-02-01")).toBe(100_000);
    expect(s.business.listPrice(null, s.router, "base", "2026-02-01")).toBe(100_000);
    expect(s.business.listPrice(s.amal, s.router, "pack", "2026-02-01")).toBe(750_000);
    // No wholesale price set: the retail price stands.
    expect(s.business.listPrice(s.amal, s.cable, "base", "2026-02-01")).toBe(1_000);
  });
});

describe("quotations", () => {
  test("a quotation is priced like an invoice and touches neither the books nor the stock", () => {
    const s = setup();
    const before = balanceOf(s.business);
    const { number } = s.quote();

    expect(number).toBe(1);
    expect(balanceOf(s.business)).toEqual(before);
    expect(s.business.stockOnHand(s.router).total).toBe(50_000);
    const q = s.business.findQuotation(1, "2026-02-10");
    expect(q).toEqual(
      expect.objectContaining({ number: 1, customerName: "شركة الأمل", validUntil: "2026-02-15", status: "open", net: 390_000, vat: 54_600, total: 444_600 }),
    );
    expect(q.lines[0]).toEqual(expect.objectContaining({ nameAr: "راوتر", unitName: "قطعة", quantity: 5_000, unitPrice: 80_000, discount: 10_000, net: 390_000 }));
  });

  test("a quotation turns into an invoice once; its status runs open, expired, converted", () => {
    const s = setup();
    s.quote();
    s.quote({ validUntil: "2026-02-05" });
    expect(s.business.quotations("2026-02-10").map((q) => [q.number, q.status])).toEqual([
      [2, "expired"],
      [1, "open"],
    ]);

    const q = s.business.findQuotation(1, "2026-02-10");
    const posted = s.business.postSalesInvoice({
      date: "2026-02-10",
      customerId: q.customerId,
      warehouseId: s.main,
      reference: q.reference,
      notes: q.notes,
      quotationId: q.id,
      // The price was edited before posting.
      lines: q.lines.map((l) => ({ itemId: l.itemId, unit: l.unit, quantity: l.quantity, unitPrice: 78_000, discount: l.discount })),
    });
    const after = s.business.findQuotation(1, "2026-02-10");
    expect(after.status).toBe("converted");
    expect(after.invoiceNumber).toBe(posted.number);
    expect(s.business.findSalesInvoice(posted.number).net).toBe(380_000);

    expect(() =>
      s.business.postSalesInvoice({ date: "2026-02-10", customerId: q.customerId, warehouseId: s.main, reference: "", notes: "", quotationId: q.id, lines: [{ itemId: s.router, unit: "base", quantity: 1_000, unitPrice: 1 }] }),
    ).toThrow(expect.objectContaining({ code: "quotation_converted" }));
    expect(() =>
      s.business.postSalesInvoice({ date: "2026-02-10", customerId: s.walkIn, warehouseId: s.main, reference: "", notes: "", quotationId: 2, lines: [{ itemId: s.router, unit: "base", quantity: 1_000, unitPrice: 1 }] }),
    ).toThrow(expect.objectContaining({ code: "quotation_customer_mismatch" }));
  });

  test("a quotation needs lines, a customer and a validity on or after its date", () => {
    const s = setup();
    expect(() => s.quote({ lines: [] })).toThrow(expect.objectContaining({ code: "invoice_needs_lines" }));
    expect(() => s.quote({ validUntil: "2026-01-31" })).toThrow(expect.objectContaining({ code: "date_range_invalid" }));
    expect(() => s.quote({ customerId: 999 })).toThrow(expect.objectContaining({ code: "customer_not_found" }));
  });
});
