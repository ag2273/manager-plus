import { describe, expect, test } from "vitest";
import { Business } from "./business";

const manager = { name: "أيمن", password: "كلمة سر قوية" };
const shop = { name: "بقالة النور", address: "الدقي", taxRegistrationNumber: "", vatRegistered: true, fiscalYearStartMonth: 1 };

function setup(settings = shop) {
  const business = Business.create(":memory:", settings, manager);
  const main = business.warehouses()[0]!.id;
  const codes = business.taxCodes();
  const standard = codes.find((c) => c.kind === "standard")!.id;
  const exempt = codes.find((c) => c.kind === "exempt")!.id;
  // Shelf price 57.00 incl. 14% VAT; a pack of 6 at 330.00.
  const soap = business.addItem({
    nameAr: "منظف أطباق 1 لتر",
    baseUnit: "قطعة",
    barcode: "6221000000035",
    salePrice: 5_700,
    taxCodeId: standard,
    pack: { name: "كرتونة", size: 6_000, barcode: "6221000000036", salePrice: 33_000 },
  });
  const bread = business.addItem({ nameAr: "عيش فينو", baseUnit: "قطعة", barcode: "111", salePrice: 150, taxCodeId: exempt });
  const supplier = business.addSupplier({ name: "المورد", phone: "", taxRegistrationNumber: "" });
  business.postPurchaseInvoice({
    date: "2026-11-01",
    supplierId: supplier,
    warehouseId: main,
    reference: "",
    lines: [
      { itemId: soap, unit: "base", quantity: 30_000, unitPrice: 4_000 },
      { itemId: bread, unit: "base", quantity: 100_000, unitPrice: 100 },
    ],
  });
  business.openShift(0);
  return { business, main, soap, bread };
}

function balanceOf(business: Business, role: string) {
  const account = business.accounts().find((a) => a.role === role)!;
  const row = business.trialBalance("2026-12-31").rows.find((r) => r.accountId === account.id);
  return row ? row.debit - row.credit : 0;
}

/** The invariants every sale must keep. */
function expectBooksBalance(business: Business, items: number[]) {
  const tb = business.trialBalance("2026-12-31");
  expect(tb.totalDebit).toBe(tb.totalCredit);
  const stockValue = items.reduce((t, id) => t + business.stockValue(id), 0);
  expect(balanceOf(business, "stock")).toBe(stockValue);
}

describe("pricing a till sale", () => {
  test("VAT-inclusive lines: net = round(gross / 1.14), VAT = gross - net; total is the sum of shelf prices", () => {
    const { business, soap, bread } = setup();

    const priced = business.priceSale("2026-11-20", [
      { itemId: soap, unit: "base", quantity: 3_000 },
      { itemId: bread, unit: "base", quantity: 10_000 },
    ]);

    // 3 × 57.00 = 171.00; 17100 / 1.14 = 15000 exactly; VAT 2100.
    expect(priced.lines[0]).toEqual(expect.objectContaining({ unitPrice: 5_700, gross: 17_100, net: 15_000, vat: 2_100, vatRate: 1400 }));
    expect(priced.lines[1]).toEqual(expect.objectContaining({ gross: 1_500, net: 1_500, vat: 0 }));
    expect(priced.total).toBe(18_600);
    expect(priced.vat).toBe(2_100);
  });

  test("net is rounded half-up per line", () => {
    const { business, soap } = setup();

    // 57.00 / 1.14 = 50.00 exactly; use 1 pack: 33000 / 1.14 = 28947.368… → 28947, VAT 4053.
    const priced = business.priceSale("2026-11-20", [{ itemId: soap, unit: "pack", quantity: 1_000 }]);

    expect(priced.lines[0]).toEqual(expect.objectContaining({ unitPrice: 33_000, gross: 33_000, net: 28_947, vat: 4_053 }));
  });
});

describe("cash sales", () => {
  test("a cash sale posts sales, output VAT, cost of goods, lowers stock and gives change", () => {
    const { business, main, soap, bread } = setup();

    const sale = business.postCashSale({
      date: "2026-11-20",
      warehouseId: main,
      lines: [
        { itemId: soap, unit: "base", quantity: 3_000 },
        { itemId: bread, unit: "base", quantity: 10_000 },
      ],
      cashReceived: 20_000,
    });

    expect(sale).toEqual(expect.objectContaining({ number: 1, total: 18_600, change: 1_400, belowZero: [] }));
    expect(balanceOf(business, "cash_drawer")).toBe(18_600);
    expect(balanceOf(business, "sales")).toBe(-16_500);
    expect(balanceOf(business, "output_vat")).toBe(-2_100);
    // Cost: 3 × 40.00 + 10 × 1.00
    expect(balanceOf(business, "cost_of_goods_sold")).toBe(12_000 + 1_000);
    expect(business.stockOnHand(soap).total).toBe(27_000);
    expect(business.stockOnHand(bread).total).toBe(90_000);
    expectBooksBalance(business, [soap, bread]);
  });

  test("receipt numbers are gap-free: a refused sale does not use a number", () => {
    const { business, main, soap } = setup();
    const line = { itemId: soap, unit: "base" as const, quantity: 1_000 };

    business.postCashSale({ date: "2026-11-20", warehouseId: main, lines: [line], cashReceived: 5_700 });
    expect(() => business.postCashSale({ date: "2026-11-20", warehouseId: main, lines: [line], cashReceived: 100 })).toThrow(
      expect.objectContaining({ code: "payment_short" }),
    );
    business.postCashSale({ date: "2026-11-20", warehouseId: main, lines: [line], cashReceived: 5_700 });

    expect(business.receipts().map((r) => r.number)).toEqual([2, 1]);
  });

  test("each receipt stores empty ETA fields, the lines and who sold it", () => {
    const { business, main, soap } = setup();

    business.postCashSale({ date: "2026-11-20", warehouseId: main, lines: [{ itemId: soap, unit: "pack", quantity: 1_000 }], cashReceived: 50_000 });

    expect(business.receipts()[0]).toEqual(
      expect.objectContaining({
        number: 1,
        date: "2026-11-20",
        total: 33_000,
        vat: 4_053,
        cashReceived: 50_000,
        change: 17_000,
        soldBy: "أيمن",
        eta: { uuid: "", previousUuid: "", status: "" },
        lines: [expect.objectContaining({ itemId: soap, unit: "pack", quantity: 1_000, gross: 33_000 })],
      }),
    );
    expect(business.stockOnHand(soap).total).toBe(24_000);
  });

  test("selling more than is on hand is allowed with a warning; cost uses the current average", () => {
    const { business, main, soap, bread } = setup();

    const sale = business.postCashSale({
      date: "2026-11-20",
      warehouseId: main,
      lines: [{ itemId: soap, unit: "base", quantity: 31_000 }],
      cashReceived: 31 * 5_700,
    });

    expect(sale.belowZero).toEqual([soap]);
    expect(business.stockOnHand(soap).total).toBe(-1_000);
    expect(balanceOf(business, "cost_of_goods_sold")).toBe(31 * 4_000);
    expectBooksBalance(business, [soap, bread]);
  });

  test("cost of goods takes exactly the stock value when the last unit is sold", () => {
    const { business, main, soap, bread } = setup();
    const supplier = business.suppliers()[0]!.id;
    // 30 at 40.00 + 1 at 40.01 → value 1240.01 for 31: the average does not divide evenly.
    business.postPurchaseInvoice({
      date: "2026-11-02",
      supplierId: supplier,
      warehouseId: main,
      reference: "",
      lines: [{ itemId: soap, unit: "base", quantity: 1_000, unitPrice: 4_001 }],
    });

    for (let i = 0; i < 3; i++) {
      business.postCashSale({ date: "2026-11-20", warehouseId: main, lines: [{ itemId: soap, unit: "base", quantity: 7_000 }], cashReceived: 7 * 5_700 });
    }
    business.postCashSale({ date: "2026-11-20", warehouseId: main, lines: [{ itemId: soap, unit: "base", quantity: 10_000 }], cashReceived: 10 * 5_700 });

    expect(business.stockOnHand(soap).total).toBe(0);
    expect(business.stockValue(soap)).toBe(0);
    expect(balanceOf(business, "cost_of_goods_sold")).toBe(124_001);
    expectBooksBalance(business, [soap, bread]);
  });

  test("a business that is not VAT-registered posts the whole price as sales", () => {
    const { business, main, soap } = setup({ ...shop, vatRegistered: false });

    business.postCashSale({ date: "2026-11-20", warehouseId: main, lines: [{ itemId: soap, unit: "base", quantity: 1_000 }], cashReceived: 5_700 });

    expect(balanceOf(business, "sales")).toBe(-5_700);
    expect(balanceOf(business, "output_vat")).toBe(0);
  });

  test("bad sales are refused", () => {
    const { business, main, soap } = setup();
    const base = { date: "2026-11-20", warehouseId: main, cashReceived: 100_000 };

    expect(() => business.postCashSale({ ...base, lines: [] })).toThrow(expect.objectContaining({ code: "invoice_needs_lines" }));
    expect(() => business.postCashSale({ ...base, lines: [{ itemId: soap, unit: "base", quantity: 0 }] })).toThrow(
      expect.objectContaining({ code: "quantity_invalid" }),
    );
    expect(() => business.postCashSale({ ...base, lines: [{ itemId: 999, unit: "base", quantity: 1_000 }] })).toThrow(
      expect.objectContaining({ code: "item_not_found" }),
    );
    expect(business.receipts()).toEqual([]);
  });

  test("a cashier can sell; a storekeeper cannot", () => {
    const { business, main, soap } = setup();
    business.addUser({ name: "سارة", role: "cashier", password: "123456" });
    business.addUser({ name: "محمود", role: "storekeeper", password: "123456" });
    const sale = { date: "2026-11-20", warehouseId: main, lines: [{ itemId: soap, unit: "base" as const, quantity: 1_000 }], cashReceived: 5_700 };

    const sara = business.signIn("سارة", "123456");
    sara.openShift(0);
    sara.postCashSale(sale);
    expect(() => business.signIn("محمود", "123456").postCashSale(sale)).toThrow(expect.objectContaining({ code: "not_allowed" }));
    expect(business.receipts()[0]!.soldBy).toBe("سارة");
  });
});
