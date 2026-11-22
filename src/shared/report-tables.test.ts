import { describe, expect, test } from "vitest";
import books from "./__fixtures__/books/reports.json";
import { a4Html } from "./a4";
import type { BusinessSettings } from "./books/business";
import type { GeneralLedger, MethodSalesRow, ProfitAndLoss } from "./books/reports";
import { ledgerTable, pnlTable, reportA4, reportSheet, salesByMethodTable } from "./report-tables";
import { xlsx } from "./xlsx";

/** What the Rust core answers after capital and a month's rent (crates/core/tests/screen_fixtures.rs). */
const settings = books.settings as BusinessSettings;

/** Pulls one stored (uncompressed) file out of the zip by its name. */
function entry(zip: Uint8Array, name: string): string {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const decoder = new TextDecoder();
  for (let at = 0; view.getUint32(at, true) === 0x04034b50; ) {
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const start = at + 30 + nameLength;
    if (decoder.decode(zip.subarray(at + 30, start)) === name) return decoder.decode(zip.subarray(start, start + size));
    at = start + size;
  }
  throw new Error(`${name} not in the zip`);
}

describe("report tables for print and Excel", () => {
  test("an English profit and loss prints left to right with English labels", async () => {
    const table = pnlTable(books.profitAndLoss as ProfitAndLoss, "en");
    expect(table.totals.map((t) => [t.label, t.value])).toEqual([
      ["Total income", 0],
      ["Total expenses", 50_000],
      ["Net profit", -50_000],
    ]);
    const html = a4Html(reportA4(table, settings));
    expect(html).toContain('dir="ltr"');
    await expect(html).toMatchFileSnapshot("__golden__/profit-and-loss-en.html");
  });

  test("the Excel file is a zip with the sheet, amounts in pounds, right to left in Arabic", () => {
    const table = ledgerTable(books.cashLedger as GeneralLedger, "ar");
    const file = xlsx(reportSheet(table));
    const sheet = entry(file, "xl/worksheets/sheet1.xml");
    expect(sheet).toContain('rightToLeft="1"');
    expect(sheet).toContain("إيجار مارس");
    expect(sheet).toContain("<v>500</v>");
    expect(sheet).toContain("<v>9500</v>");
    expect(entry(file, "xl/workbook.xml")).toContain("دفتر الأستاذ");
    const end = new DataView(file.buffer, file.byteLength - 22);
    expect(end.getUint32(0, true)).toBe(0x06054b50);
    expect(end.getUint16(10, true)).toBe(6);
  });

  test("an English sheet runs left to right and names the payment methods", () => {
    const table = salesByMethodTable(books.salesByPaymentMethod as MethodSalesRow[], "2026-03-01", "2026-03-31", "en");
    const sheet = entry(xlsx(reportSheet(table)), "xl/worksheets/sheet1.xml");
    expect(sheet).not.toContain("rightToLeft");
    expect(sheet).toContain("Wallet / InstaPay");
  });
});
