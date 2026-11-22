import { describe, expect, test } from "vitest";
import { setDigitStyle } from "./digits";
import books from "./__fixtures__/books/receipts.json";
import type { BusinessSettings } from "./books/business";
import type { SaleReturn } from "./books/returns";
import type { Receipt } from "./books/sales";
import type { ZReport } from "./books/shifts";
import { documentHtml, returnDocument, saleDocument, zReportDocument } from "./receipt";

/** What the Rust core answers for a till sale, its return and the shift's Z report (crates/core/tests/screen_fixtures.rs). */
const settings = books.settings as BusinessSettings;
const sale = books.receipt as Receipt;

/** Times are when the test ran; fix them so the golden file is stable. */
const fixed = <T extends { at: string }>(x: T): T => ({ ...x, at: "2026-11-20T18:15:00.000Z" });

describe("printed receipts", () => {
  test("a sale receipt matches the golden file", async () => {
    const doc = saleDocument(fixed(sale), settings, { footer: "شكرًا لزيارتكم\nالاستبدال خلال 14 يوم بالإيصال", copy: false });

    expect(doc.totals).toEqual([
      { label: "الإجمالي قبل الخصم", value: "123.50" },
      { label: "الخصم", value: "−2.50" },
      { label: "الإجمالي", value: "121.00", strong: true },
      { label: "منها ضريبة القيمة المضافة", value: "14.86" },
      { label: "نقدي", value: "150.00" },
      { label: "الباقي", value: "29.00" },
    ]);
    await expect(documentHtml({ ...doc, when: "2026-11-20 20:15" })).toMatchFileSnapshot("__golden__/sale-receipt.html");
  });

  test("a reprint is marked as a copy, and a return points to its sale", async () => {
    const receipt = sale;
    const copy = documentHtml(saleDocument(receipt, settings, { footer: "", copy: true }));
    const ret = returnDocument(fixed(books.return as SaleReturn), settings, { footer: "", copy: false });

    expect(copy).toContain(`<div class="center copy">نسخة</div>`);
    expect(ret.reference).toBe("من إيصال بيع رقم 1");
    await expect(documentHtml({ ...ret, when: "2026-11-20 20:15" })).toMatchFileSnapshot("__golden__/return-receipt.html");
  });

  test("an e-receipt carries its ETA link as a QR code", async () => {
    const doc = saleDocument(fixed(sale), settings, { footer: "", copy: false });
    const link = "https://preprod.invoicing.eta.gov.eg/receipts/search/abc/share/2026-11-20T18:15:00Z#Total:121,IssuerRIN:123456789";
    await expect(documentHtml({ ...doc, when: "2026-11-20 20:15", qr: link })).toMatchFileSnapshot("__golden__/sale-receipt-qr.html");
    expect(documentHtml(doc)).not.toContain("<svg");
  });

  test("the sale receipt in English", async () => {
    const doc = saleDocument(fixed(sale), settings, { footer: "Thank you for your visit", copy: true }, "en");

    expect(doc.totals.map((t) => t.label)).toEqual(["Total before discount", "Discount", "Total", "Of which VAT", "Cash", "Change"]);
    // An item without an English name keeps its Arabic one.
    expect(doc.lines.map((l) => l.name)).toEqual(["Egyptian rice 1 kg", "شاي ناعم 250 جم"]);
    await expect(documentHtml({ ...doc, when: "2026-11-20 20:15" })).toMatchFileSnapshot("__golden__/sale-receipt-en.html");
  });

  test("the Z report prints in Arabic and in English", async () => {
    const report = books.zReport as ZReport;
    const stable = { ...report, shift: { ...report.shift, openedAt: "2026-11-20T07:00:00.000Z", closedAt: "2026-11-20T19:00:00.000Z" } };

    const arabic = zReportDocument(stable, settings);
    expect(arabic.totals.at(-1)).toEqual({ label: "الفرق (زيادة + / عجز −)", value: "-1.00", strong: true });
    await expect(documentHtml({ ...arabic, reference: "2026-11-20 09:00 → 2026-11-20 21:00", when: "2026-11-20 21:00" })).toMatchFileSnapshot(
      "__golden__/z-report.html",
    );
    const english = zReportDocument(stable, settings, "en");
    expect(english.totals[1]).toEqual({ label: "Total sales", value: "121.00" });
    await expect(documentHtml({ ...english, reference: "2026-11-20 09:00 → 2026-11-20 21:00", when: "2026-11-20 21:00" })).toMatchFileSnapshot(
      "__golden__/z-report-en.html",
    );
  });

  test("Arabic-Indic digits reach the printed receipt", () => {
    setDigitStyle("arabic");
    try {
      const doc = saleDocument(sale, settings, { footer: "", copy: false });
      expect(doc.totals.find((t) => t.strong)!.value).toBe("١٢١٫٠٠");
    } finally {
      setDigitStyle("western");
    }
  });

  test("text from the business is escaped", () => {
    const doc = saleDocument(sale, { ...settings, name: "<b>محل</b>" }, { footer: "", copy: false });

    expect(documentHtml(doc)).toContain("&lt;b&gt;محل&lt;/b&gt;");
  });
});
