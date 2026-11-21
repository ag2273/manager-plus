import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { Business } from "../core/business";
import { importTemplate } from "./import-template";
import { decodeCsv, parseCsv, readXlsx } from "./spreadsheet-read";
import { zip } from "./xlsx";

const inflate = (data: Uint8Array) => new Uint8Array(inflateRawSync(data));
const encoder = new TextEncoder();

describe("reading spreadsheets for import", () => {
  test("a compressed workbook saved by a spreadsheet program: sheets, numbers without float noise, blanks kept in place", () => {
    const sheets = readXlsx(new Uint8Array(readFileSync(`${__dirname}/__fixtures__/import-sample.xlsx`)), inflate);
    expect(sheets.map((s) => s.name)).toEqual(["الأصناف", "Opening balances"]);
    expect(sheets[0]!.rows[1]).toEqual(["راوتر & سويتش", "قطعة", "6221000000017", "1140.5", "عام", "25", "600"]);
    expect(sheets[0]!.rows[2]).toEqual(["كابل", "متر", "", "11.4", "", "100.5", "5.25"]);
    expect(sheets[1]!.rows).toEqual([
      ["Type", "Name or account code", "Debit", "Credit"],
      ["customer", "شركة الأمل", "1250.5"],
    ]);
  });

  test("shared strings, rich text and skipped rows", () => {
    const files = {
      "xl/workbook.xml": `<workbook><sheets><sheet name="A &amp; B" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>`,
      "xl/sharedStrings.xml": `<sst><si><t>صنف</t></si><si><r><t>راوتر </t></r><r><rPr><b/></rPr><t xml:space="preserve">واي فاي</t></r></si></sst>`,
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="B1" t="s"><v>0</v></c></row><row r="3"><c r="A3" t="s"><v>1</v></c><c r="C3"><v>1140.0000000001</v></c><c r="D3" t="str"><v>2</v><f>1+1</f></c></row></sheetData></worksheet>`,
    };
    const bytes = zip(Object.entries(files).map(([name, text]) => ({ name, data: encoder.encode(text) })));
    expect(readXlsx(bytes, inflate)).toEqual([{ name: "A & B", rows: [["", "صنف"], [], ["راوتر واي فاي", "", "1140", "2"]] }]);
  });

  test("CSV with quotes, semicolons and Windows Arabic encoding", () => {
    expect(parseCsv('﻿اسم,سعر\r\n"راوتر, 6",1140\r\n"قال ""أهلا""",\n')).toEqual([
      ["اسم", "سعر"],
      ["راوتر, 6", "1140"],
      ['قال "أهلا"', ""],
    ]);
    expect(parseCsv("a;b\n1,5;2")).toEqual([
      ["a", "b"],
      ["1,5", "2"],
    ]);
    // "صنف" in Windows-1256.
    expect(decodeCsv(new Uint8Array([0xd5, 0xe4, 0xdd]))).toBe("صنف");
    expect(decodeCsv(encoder.encode("صنف"))).toBe("صنف");
  });

  test("the template, in Arabic and English, reads back and its example rows import cleanly", () => {
    for (const lang of ["ar", "en"] as const) {
      const sheets = readXlsx(importTemplate(lang), inflate);
      expect(sheets.map((s) => s.name)).toEqual(lang === "ar" ? ["الأصناف", "الأرصدة الافتتاحية"] : ["Items", "Opening balances"]);
      const business = Business.create(
        ":memory:",
        { name: "متجر", address: "", taxRegistrationNumber: "", vatRegistered: true, fiscalYearStartMonth: 1 },
        { name: "أيمن", password: "كلمة سر قوية" },
      );
      const report = business.checkImport({ date: "2026-01-01", warehouseId: business.warehouses()[0]!.id, sheets });
      expect(report).toEqual(expect.objectContaining({ items: 1, stockLines: 1, balances: 3, newCustomers: 1, newSuppliers: 1, problems: [] }));
    }
  });
});
