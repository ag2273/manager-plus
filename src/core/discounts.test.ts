import { describe, expect, test } from "vitest";
import { Business } from "./business";

const manager = { name: "أيمن", password: "كلمة سر قوية" };
const shop = { name: "بقالة النور", address: "الدقي", taxRegistrationNumber: "", vatRegistered: true, fiscalYearStartMonth: 1 };

function setup() {
  const business = Business.create(":memory:", shop, manager);
  const main = business.warehouses()[0]!.id;
  const codes = business.taxCodes();
  const standard = codes.find((c) => c.kind === "standard")!.id;
  const exempt = codes.find((c) => c.kind === "exempt")!.id;
  const rice = business.addItem({ nameAr: "أرز", baseUnit: "كيس", barcode: "11", salePrice: 3_800, taxCodeId: standard });
  const sugar = business.addItem({ nameAr: "سكر", baseUnit: "كيس", barcode: "28", salePrice: 3_450, taxCodeId: standard });
  const bread = business.addItem({ nameAr: "عيش", baseUnit: "رغيف", barcode: "35", salePrice: 5_700, taxCodeId: exempt });
  const supplier = business.addSupplier({ name: "المورد", phone: "", taxRegistrationNumber: "" });
  business.postPurchaseInvoice({
    date: "2026-11-01",
    supplierId: supplier,
    warehouseId: main,
    reference: "",
    lines: [rice, sugar, bread].map((itemId) => ({ itemId, unit: "base" as const, quantity: 100_000, unitPrice: 1_000 })),
  });
  business.openShift(0);
  return { business, main, rice, sugar, bread };
}

function balanceOf(business: Business, role: string) {
  const account = business.accounts().find((a) => a.role === role)!;
  const row = business.trialBalance("2026-12-31").rows.find((r) => r.accountId === account.id);
  return row ? row.debit - row.credit : 0;
}

describe("till discounts", () => {
  test("a line discount by amount or percentage reduces that line; VAT is on the discounted price", () => {
    const { business, rice, sugar } = setup();

    const priced = business.priceSale("2026-11-20", [
      // 2 × 38.00 = 76.00, less 2.50 = 73.50 → net 64.47, VAT 9.03
      { itemId: rice, unit: "base", quantity: 2_000, discount: { kind: "amount", value: 250 } },
      // 3 × 34.50 = 103.50, less 10% = 10.35 → 93.15 → net 81.71, VAT 11.44
      { itemId: sugar, unit: "base", quantity: 3_000, discount: { kind: "percent", value: 1_000 } },
    ]);

    expect(priced.lines[0]).toEqual(expect.objectContaining({ gross: 7_600, discount: 250, amount: 7_350, net: 6_447, vat: 903 }));
    expect(priced.lines[1]).toEqual(expect.objectContaining({ gross: 10_350, discount: 1_035, amount: 9_315, net: 8_171, vat: 1_144 }));
    expect(priced.total).toBe(16_665);
    expect(priced.discount).toBe(1_285);
    expect(priced.gross).toBe(17_950);
  });

  test("a receipt discount is spread over the lines by amount; the remainder goes to the largest line", () => {
    const { business, rice, sugar, bread } = setup();

    // Lines 76.00, 103.50, 57.00 = 236.50, less 10.00 for the receipt.
    const priced = business.priceSale(
      "2026-11-20",
      [
        { itemId: rice, unit: "base", quantity: 2_000 },
        { itemId: sugar, unit: "base", quantity: 3_000 },
        { itemId: bread, unit: "base", quantity: 1_000 },
      ],
      { kind: "amount", value: 1_000 },
    );

    // Shares 3.21, 4.37 (+0.01 remainder), 2.41.
    expect(priced.lines.map((l) => l.discount)).toEqual([321, 438, 241]);
    expect(priced.total).toBe(22_650);
    expect(priced.lines[2]).toEqual(expect.objectContaining({ amount: 5_459, net: 5_459, vat: 0 }));
  });

  test("a receipt discount by percentage comes after line discounts", () => {
    const { business, rice } = setup();

    // 10 × 38.00 = 380.00, less 20.00 = 360.00, less 5% = 18.00 → 342.00
    const priced = business.priceSale(
      "2026-11-20",
      [{ itemId: rice, unit: "base", quantity: 10_000, discount: { kind: "amount", value: 2_000 } }],
      { kind: "percent", value: 500 },
    );

    expect(priced.lines[0]!.discount).toBe(3_800);
    expect(priced.total).toBe(34_200);
  });

  test("a discounted sale posts sales net of discount, and the Z report shows the discounts", () => {
    const { business, main, rice, sugar } = setup();

    business.postSale({
      date: "2026-11-20",
      warehouseId: main,
      lines: [
        { itemId: rice, unit: "base", quantity: 2_000, discount: { kind: "amount", value: 250 } },
        { itemId: sugar, unit: "base", quantity: 3_000, discount: { kind: "percent", value: 1_000 } },
      ],
      payments: [{ method: "cash", amount: 20_000 }],
    });

    expect(balanceOf(business, "cash_drawer")).toBe(16_665);
    expect(balanceOf(business, "sales")).toBe(-(6_447 + 8_171));
    expect(balanceOf(business, "output_vat")).toBe(-(903 + 1_144));
    const z = business.zReport(business.currentShift()!.id);
    expect(z.sales.total).toBe(16_665);
    expect(z.discounts).toBe(1_285);
    expect(business.receipts()[0]!.lines[0]).toEqual(expect.objectContaining({ discount: 250, amount: 7_350 }));
  });

  test("discounts must be sensible", () => {
    const { business, rice } = setup();
    const line = { itemId: rice, unit: "base" as const, quantity: 1_000 };

    expect(() => business.priceSale("2026-11-20", [{ ...line, discount: { kind: "amount", value: 3_801 } }])).toThrow(
      expect.objectContaining({ code: "discount_invalid" }),
    );
    expect(() => business.priceSale("2026-11-20", [{ ...line, discount: { kind: "percent", value: 10_001 } }])).toThrow(
      expect.objectContaining({ code: "discount_invalid" }),
    );
    expect(() => business.priceSale("2026-11-20", [line], { kind: "amount", value: -1 })).toThrow(
      expect.objectContaining({ code: "discount_invalid" }),
    );
    expect(() => business.priceSale("2026-11-20", [line], { kind: "amount", value: 3_801 })).toThrow(
      expect.objectContaining({ code: "discount_invalid" }),
    );
  });
});

describe("held receipts", () => {
  test("a held receipt is not posted, uses no receipt number, and can be recalled once", () => {
    const { business, main, rice } = setup();
    const cart = { warehouseId: main, lines: [{ itemId: rice, unit: "base" as const, quantity: 2_000 }], note: "الزبون رجع يجيب فلوس" };

    const held = business.holdSale(cart);
    business.postCashSale({ date: "2026-11-20", warehouseId: main, lines: [{ itemId: rice, unit: "base", quantity: 1_000 }], cashReceived: 3_800 });

    expect(business.heldSales()).toEqual([expect.objectContaining({ id: held, note: "الزبون رجع يجيب فلوس", lines: cart.lines })]);
    expect(business.receipts().map((r) => r.number)).toEqual([1]);
    expect(business.stockOnHand(rice).total).toBe(99_000);

    expect(business.recallSale(held)).toEqual(expect.objectContaining({ warehouseId: main, lines: cart.lines }));
    expect(business.heldSales()).toEqual([]);
    expect(() => business.recallSale(held)).toThrow(expect.objectContaining({ code: "held_sale_not_found" }));
  });
});
