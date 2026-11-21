import { BALANCE_COLUMNS, ITEM_COLUMNS, type ImportColumn, SHEET_NAMES } from "./import-columns";
import type { Lang } from "./report-tables";
import { type Sheet, xlsxBook } from "./xlsx";

function sheet<K extends string>(name: string, columns: ImportColumn<K>[], lang: Lang, examples: string[][]): Sheet {
  return {
    name,
    rightToLeft: lang === "ar",
    // Every column is text, so barcodes keep their leading zeros and prices stay as typed.
    columns: columns.map((c) => ({ label: c[lang], kind: "text" as const })),
    rows: examples,
  };
}

/** The import template: an items sheet and an opening balances sheet, each with an example row. */
export function importTemplate(lang: Lang): Uint8Array {
  const accountExample = lang === "ar" ? ["حساب", "1110", "50000.00", ""] : ["account", "1110", "50000.00", ""];
  const supplierExample = lang === "ar" ? ["مورد", "شركة التوريدات", "", "8000.00"] : ["supplier", "Supplies Co.", "", "8000.00"];
  return xlsxBook([
    sheet(SHEET_NAMES.items[lang], ITEM_COLUMNS, lang, [ITEM_COLUMNS.map((c) => c.example[lang])]),
    sheet(SHEET_NAMES.balances[lang], BALANCE_COLUMNS, lang, [BALANCE_COLUMNS.map((c) => c.example[lang]), accountExample, supplierExample]),
  ]);
}
