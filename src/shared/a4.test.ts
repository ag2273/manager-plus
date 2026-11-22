import { describe, expect, test } from "vitest";
import books from "./__fixtures__/books/a4.json";
import { a4Html, creditNoteA4, deliveryNoteA4, invoiceA4, quotationA4, statementA4 } from "./a4";
import type { CreditNote, SalesInvoice } from "./books/invoices";
import type { Customer } from "./books/customers";
import type { BusinessSettings } from "./books/business";
import type { Quotation } from "./books/quotations";
import type { Statement } from "./books/settlements";

/** What the Rust core answers for a company invoice, its credit note and a quotation (crates/core/tests/screen_fixtures.rs). */
const settings = books.settings as BusinessSettings;
const customer = books.customer as Customer;
const invoice = books.invoice as SalesInvoice;

describe("A4 documents", () => {
  test("a tax invoice matches the golden file, with the buyer's tax number and the total in words", async () => {
    const doc = invoiceA4(invoice, settings, customer);

    expect(doc.title).toBe("فاتورة ضريبية");
    expect(doc.words).toBe("فقط ألفان وستمائة واثنان وعشرون جنيه مصري لا غير");
    expect(doc.rows[0]).toEqual(["1", "راوتر واي فاي 6", "قطعة", "2", "1,200.00", "100.00", "2,300.00", "322.00 (14%)", "2,622.00"]);
    await expect(a4Html(doc)).toMatchFileSnapshot("__golden__/sales-invoice.html");
  });

  test("the same invoice in English reads left to right, with English labels, names and words", async () => {
    const doc = invoiceA4(invoice, settings, customer, "en");

    expect(doc.title).toBe("Tax invoice");
    expect(doc.words).toBe("Only two thousand six hundred twenty-two Egyptian pounds");
    expect(doc.rows[0]).toEqual(["1", "Wi-Fi 6 router", "قطعة", "2", "1,200.00", "100.00", "2,300.00", "322.00 (14%)", "2,622.00"]);
    const html = a4Html(doc);
    expect(html).toContain('<html lang="en" dir="ltr">');
    await expect(html).toMatchFileSnapshot("__golden__/sales-invoice-en.html");
  });

  test("a credit note points to its invoice", () => {
    const doc = creditNoteA4(books.creditNote as CreditNote, settings, customer);

    expect(doc.meta).toContainEqual({ label: "على فاتورة رقم", value: "1" });
    expect(doc.totals.at(-1)).toEqual({ label: "إجمالي الإشعار", value: "1,311.00", strong: true });
  });

  test("a statement starts from the balance brought forward", () => {
    const st = books.statement as Statement;

    const doc = statementA4(st, settings, { kind: "customer", address: customer.address, taxRegistrationNumber: customer.taxRegistrationNumber });

    expect(doc.rows).toEqual([
      ["2026-11-01", "رصيد أول المدة", "", "", "0.00"],
      ["2026-11-20", "فاتورة مبيعات رقم 1 - شركة الأمل للتجارة", "2,622.00", "", "2,622.00"],
    ]);
    expect(doc.totals[0]!.value).toBe("2,622.00");
  });

  test("text from the business is escaped", () => {
    const html = a4Html(invoiceA4(invoice, settings, { ...customer, name: "<b>x</b>" }));
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});

describe("quotations and delivery notes", () => {
  test("a quotation shows its validity, and a delivery note shows quantities without prices", () => {
    const quote = quotationA4(books.quotation as Quotation, settings, customer);
    expect(quote.title).toBe("عرض سعر");
    expect(quote.meta).toContainEqual({ label: "ساري حتى", value: "2026-11-30" });
    expect(quote.totals.at(-1)).toEqual({ label: "الإجمالي", value: "4,104.00", strong: true });

    const note = deliveryNoteA4(invoice, settings, customer);
    expect(note.title).toBe("إذن تسليم");
    expect(note.columns.map((c) => c.label)).toEqual(["م", "الصنف", "الوحدة", "الكمية"]);
    expect(note.rows).toEqual([["1", "راوتر واي فاي 6", "قطعة", "2"]]);
    expect(note.totals).toEqual([]);
    expect(a4Html(note)).not.toContain("1,200.00");
  });
});
