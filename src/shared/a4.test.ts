import { describe, expect, test } from "vitest";
import { Business } from "../core/business";
import { a4Html, creditNoteA4, deliveryNoteA4, invoiceA4, quotationA4, statementA4 } from "./a4";

const manager = { name: "أيمن", password: "كلمة سر قوية" };
const shop = { name: "شركة النور للكمبيوتر", address: "الدقي، الجيزة", taxRegistrationNumber: "123456789", vatRegistered: true, fiscalYearStartMonth: 1 };

function sample() {
  const business = Business.create(":memory:", shop, manager);
  const main = business.warehouses()[0]!.id;
  const standard = business.taxCodes().find((c) => c.kind === "standard")!.id;
  const router = business.addItem({ nameAr: "راوتر واي فاي 6", baseUnit: "قطعة", salePrice: 150_000, taxCodeId: standard });
  const customer = business.addCustomer({ name: "شركة الأمل للتجارة", phone: "", taxRegistrationNumber: "987654321", address: "مدينة نصر، القاهرة" });
  const posted = business.postSalesInvoice({
    date: "2026-11-20",
    customerId: customer,
    warehouseId: main,
    reference: "PO-15",
    notes: "التسليم في مقر العميل",
    lines: [{ itemId: router, unit: "base", quantity: 2_000, unitPrice: 120_000, discount: 10_000 }],
  });
  return { business, customer: business.customers()[0]!, posted };
}

describe("A4 documents", () => {
  test("a tax invoice matches the golden file, with the buyer's tax number and the total in words", async () => {
    const { business, customer } = sample();
    const doc = invoiceA4(business.findSalesInvoice(1), business.settings(), customer);

    expect(doc.title).toBe("فاتورة ضريبية");
    expect(doc.words).toBe("فقط ألفان وستمائة واثنان وعشرون جنيه مصري لا غير");
    expect(doc.rows[0]).toEqual(["1", "راوتر واي فاي 6", "قطعة", "2", "1,200.00", "100.00", "2,300.00", "322.00 (14%)", "2,622.00"]);
    await expect(a4Html(doc)).toMatchFileSnapshot("__golden__/sales-invoice.html");
  });

  test("a credit note points to its invoice", () => {
    const { business, customer, posted } = sample();
    const line = business.findSalesInvoice(1).lines[0]!.lineId;
    business.postCreditNote({ date: "2026-11-21", invoiceId: posted.id, reason: "عيب", lines: [{ lineId: line, quantity: 1_000 }] });

    const doc = creditNoteA4(business.findCreditNote(1), business.settings(), customer);

    expect(doc.meta).toContainEqual({ label: "على فاتورة رقم", value: "1" });
    expect(doc.totals.at(-1)).toEqual({ label: "إجمالي الإشعار", value: "1,311.00", strong: true });
  });

  test("a statement starts from the balance brought forward", () => {
    const { business, customer } = sample();
    const st = business.statement("customer", customer.id, "2026-11-01", "2026-11-30");

    const doc = statementA4(st, business.settings(), { kind: "customer", address: customer.address, taxRegistrationNumber: customer.taxRegistrationNumber });

    expect(doc.rows).toEqual([
      ["2026-11-01", "رصيد أول المدة", "", "", "0.00"],
      ["2026-11-20", "فاتورة مبيعات رقم 1 - شركة الأمل للتجارة", "2,622.00", "", "2,622.00"],
    ]);
    expect(doc.totals[0]!.value).toBe("2,622.00");
  });

  test("text from the business is escaped", () => {
    const { business, customer } = sample();
    const html = a4Html(invoiceA4(business.findSalesInvoice(1), business.settings(), { ...customer, name: "<b>x</b>" }));
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});

describe("quotations and delivery notes", () => {
  test("a quotation shows its validity, and a delivery note shows quantities without prices", () => {
    const { business, customer } = sample();
    const router = business.items()[0]!.id;
    business.saveQuotation({
      date: "2026-11-20",
      validUntil: "2026-11-30",
      customerId: customer.id,
      reference: "RFQ-3",
      notes: "",
      lines: [{ itemId: router, unit: "base", quantity: 3_000, unitPrice: 120_000 }],
    });
    const quote = quotationA4(business.findQuotation(1, "2026-11-20"), business.settings(), customer);
    expect(quote.title).toBe("عرض سعر");
    expect(quote.meta).toContainEqual({ label: "ساري حتى", value: "2026-11-30" });
    expect(quote.totals.at(-1)).toEqual({ label: "الإجمالي", value: "4,104.00", strong: true });

    const note = deliveryNoteA4(business.findSalesInvoice(1), business.settings(), customer);
    expect(note.title).toBe("إذن تسليم");
    expect(note.columns.map((c) => c.label)).toEqual(["م", "الصنف", "الوحدة", "الكمية"]);
    expect(note.rows).toEqual([["1", "راوتر واي فاي 6", "قطعة", "2"]]);
    expect(note.totals).toEqual([]);
    expect(a4Html(note)).not.toContain("1,200.00");
  });
});
