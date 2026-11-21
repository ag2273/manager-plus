import { describe, expect, test } from "vitest";
import { Business } from "./business";

const manager = { name: "أيمن", password: "كلمة سر قوية" };
const shop = { name: "شركة النور للكمبيوتر", address: "", taxRegistrationNumber: "", vatRegistered: true, fiscalYearStartMonth: 1 };

const ITEMS_HEADER = [
  "اسم الصنف بالعربية",
  "الوحدة",
  "الباركود",
  "سعر البيع شامل الضريبة",
  "الضريبة",
  "وحدة العبوة",
  "عدد الوحدات في العبوة",
  "سعر العبوة",
  "الكمية الافتتاحية",
  "تكلفة الوحدة",
];

function setup() {
  const business = Business.create(":memory:", shop, manager);
  const warehouseId = business.warehouses()[0]!.id;
  const balanceOf = (role: string) => {
    const account = business.accounts().find((a) => a.role === role)!;
    const row = business.trialBalance("2026-12-31").rows.find((r) => r.accountId === account.id);
    return row ? row.debit - row.credit : 0;
  };
  const cash = business.accounts().find((a) => a.role === "main_cash")!.code;
  return { business, warehouseId, balanceOf, cash };
}

const goodFile = (cashCode: string) => [
  {
    name: "الأصناف",
    rows: [
      [],
      ITEMS_HEADER,
      ["راوتر", "قطعة", "6221000000017", "1,140.00", "عام", "كرتونة", "10", "11000", "25", "600"],
      ["كتاب", "قطعة", "6221000000024", "50", "معفى", "", "", "", "", ""],
      ["", "", "", "", "", "", "", "", "", ""],
      ["كابل", "متر", "", "11.4", "", "", "", "", "100.5", "5.25"],
    ],
  },
  {
    name: "Opening balances",
    rows: [
      ["Type", "Name or account code", "Debit", "Credit"],
      ["account", cashCode, "5000", ""],
      ["customer", "شركة الأمل", "1250.50", ""],
      ["supplier", "مورد قديم", "", "3000"],
    ],
  },
];

describe("importing items, opening stock and opening balances", () => {
  test("a dry run counts what would be imported and saves nothing", () => {
    const { business, warehouseId, cash } = setup();
    const report = business.checkImport({ date: "2026-01-01", warehouseId, sheets: goodFile(cash) });
    expect(report).toEqual({ items: 3, stockLines: 2, stockValue: 1_500_000 + 52_763, balances: 3, newCustomers: 1, newSuppliers: 1, problems: [] });
    expect(business.items()).toEqual([]);
    expect(business.customers()).toEqual([]);
    expect(business.trialBalance("2026-12-31").rows).toEqual([]);
  });

  test("the import adds the items and posts opening stock and balances: Dr Stock, Cr Opening balances", () => {
    const { business, warehouseId, balanceOf, cash } = setup();
    business.importData({ date: "2026-01-01", warehouseId, sheets: goodFile(cash) });
    const router = business.items().find((i) => i.nameAr === "راوتر")!;
    expect(router).toEqual(
      expect.objectContaining({
        baseUnit: "قطعة",
        barcode: "6221000000017",
        salePrice: 114_000,
        pack: expect.objectContaining({ name: "كرتونة", size: 10_000, salePrice: 1_100_000 }),
      }),
    );
    expect(business.items().find((i) => i.nameAr === "كتاب")!.taxCodeId).toBe(business.taxCodes().find((c) => c.kind === "exempt")!.id);
    expect(business.stockOnHand(router.id).total).toBe(25_000);
    // 25 × 600.00 + 100.5 m × 5.25 = 15,000.00 + 527.63
    expect(balanceOf("stock")).toBe(1_552_763);
    expect(balanceOf("main_cash")).toBe(500_000);
    expect(business.customerBalance(business.customers()[0]!.id)).toBe(125_050);
    expect(business.supplierBalance(business.suppliers()[0]!.id)).toBe(300_000);
    expect(balanceOf("opening_balances")).toBe(-(1_552_763 + 500_000 + 125_050 - 300_000));
  });

  test("every bad row is reported, and the import saves nothing", () => {
    const { business, warehouseId } = setup();
    const sheets = [
      {
        name: "الأصناف",
        rows: [
          ITEMS_HEADER,
          ["راوتر", "قطعة", "111", "1140", "", "", "", "", "", ""],
          ["سويتش", "قطعة", "111", "500", "", "", "", "", "", ""],
          ["كابل", "متر", "", "", "", "", "", "", "", ""],
          ["فلاشة", "قطعة", "", "100", "مخفض", "", "", "", "", ""],
          ["ماوس", "قطعة", "", "100", "", "", "", "", "5", ""],
          ["كيبورد", "قطعة", "", "abc", "", "", "", "", "", ""],
        ],
      },
      {
        name: "أرصدة",
        rows: [
          ["النوع", "الاسم أو كود الحساب", "مدين", "دائن"],
          ["حساب", "9999", "10", ""],
          ["شريك", "x", "10", ""],
          ["عميل", "أ", "10", "5"],
        ],
      },
    ];
    const report = business.checkImport({ date: "2026-01-01", warehouseId, sheets });
    expect(report.problems.map((p) => [p.sheet, p.row, p.column, p.code])).toEqual([
      ["الأصناف", 3, "barcode", "barcode_taken"],
      ["الأصناف", 4, "salePrice", "import_value_required"],
      ["الأصناف", 5, "tax", "tax_code_unknown"],
      ["الأصناف", 6, "unitCost", "cost_required"],
      ["الأصناف", 7, "salePrice", "price_invalid"],
      ["أرصدة", 2, "name", "account_not_found"],
      ["أرصدة", 3, "type", "party_type_unknown"],
      ["أرصدة", 4, "credit", "line_amount_invalid"],
    ]);
    expect(() => business.importData({ date: "2026-01-01", warehouseId, sheets })).toThrow(expect.objectContaining({ code: "import_invalid" }));
    expect(business.items()).toEqual([]);
    expect(business.customers()).toEqual([]);
  });

  test("a sheet without a required column, or a file with no known sheet, is refused", () => {
    const { business, warehouseId } = setup();
    const noUnit = business.checkImport({
      date: "2026-01-01",
      warehouseId,
      sheets: [
        {
          name: "Items",
          rows: [
            ["Arabic name", "Sale price incl. VAT"],
            ["x", "1"],
          ],
        },
      ],
    });
    expect(noUnit.problems).toEqual([{ sheet: "Items", row: 1, column: "baseUnit", code: "import_column_missing", value: "الوحدة" }]);
    const nothing = business.checkImport({ date: "2026-01-01", warehouseId, sheets: [{ name: "Sheet1", rows: [["a", "b"]] }] });
    expect(nothing.problems.map((p) => p.code)).toEqual(["import_nothing"]);
  });

  test("5,000 items with opening stock import in under 30 seconds", () => {
    const { business, warehouseId } = setup();
    const rows = [
      ITEMS_HEADER,
      ...Array.from({ length: 5_000 }, (_, i) => [`صنف ${i}`, "قطعة", String(6_220_000_000_000 + i), "114", "", "", "", "", "3", "60"]),
    ];
    const started = performance.now();
    const report = business.importData({ date: "2026-01-01", warehouseId, sheets: [{ name: "الأصناف", rows }] });
    expect(performance.now() - started).toBeLessThan(30_000);
    expect([report.items, report.stockLines, report.problems]).toEqual([5_000, 5_000, []]);
    expect(business.items()).toHaveLength(5_000);
  });
});
