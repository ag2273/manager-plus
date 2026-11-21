import { describe, expect, test } from "vitest";
import { Business } from "./business";

const manager = { name: "أيمن", password: "كلمة سر قوية" };
const shop = { name: "شركة النور للكمبيوتر", address: "", taxRegistrationNumber: "", vatRegistered: true, fiscalYearStartMonth: 1 };

function setup() {
  const business = Business.create(":memory:", shop, manager);
  const main = business.warehouses()[0]!.id;
  const branch = business.addWarehouse("فرع المعادي");
  const standard = business.taxCodes().find((c) => c.kind === "standard")!.id;
  const router = business.addItem({ nameAr: "راوتر", baseUnit: "قطعة", salePrice: 114_000, taxCodeId: standard });
  const cable = business.addItem({ nameAr: "كابل", baseUnit: "متر", salePrice: 1_140, taxCodeId: standard });
  const supplier = business.addSupplier({ name: "مورد", phone: "", taxRegistrationNumber: "" });
  const customer = business.addCustomer({ name: "شركة الأمل", phone: "", taxRegistrationNumber: "" });
  const buy = (date: string, itemId: number, units: number, unitPrice: number, warehouseId = main) =>
    business.postPurchaseInvoice({
      date,
      supplierId: supplier,
      warehouseId,
      reference: "",
      lines: [{ itemId, unit: "base", quantity: units * 1_000, unitPrice }],
    });
  const sell = (date: string, itemId: number, units: number, warehouseId = main) =>
    business.postSalesInvoice({
      date,
      customerId: customer,
      warehouseId,
      reference: "",
      notes: "",
      lines: [{ itemId, unit: "base", quantity: units * 1_000, unitPrice: 100_000 }],
    });
  return { business, main, branch, router, cable, buy, sell };
}

function balanceOf(business: Business, role: string) {
  const account = business.accounts().find((a) => a.role === role)!;
  const row = business.trialBalance("2026-12-31").rows.find((r) => r.accountId === account.id);
  return row ? row.debit - row.credit : 0;
}

describe("stock counts and write-offs", () => {
  test("a count posts the difference as a gain or a loss at average cost", () => {
    const s = setup();
    s.buy("2026-01-01", s.router, 10, 60_000);
    s.buy("2026-01-01", s.cable, 100, 500);
    const count = s.business.postStockCount({
      date: "2026-01-31",
      warehouseId: s.main,
      memo: "جرد يناير",
      lines: [
        { itemId: s.router, counted: 8_000 },
        { itemId: s.cable, counted: 103_000 },
      ],
    });
    expect(s.business.stockOnHand(s.router).total).toBe(8_000);
    expect(s.business.stockOnHand(s.cable).total).toBe(103_000);
    expect(balanceOf(s.business, "stock_loss")).toBe(120_000);
    expect(balanceOf(s.business, "stock_gain")).toBe(-1_500);
    expect(balanceOf(s.business, "stock")).toBe(600_000 - 120_000 + 50_000 + 1_500);
    expect(s.business.stockCounts()[0]).toEqual(
      expect.objectContaining({
        id: count,
        memo: "جرد يناير",
        lines: [
          expect.objectContaining({ expected: 10_000, counted: 8_000, difference: -2_000, value: -120_000 }),
          expect.objectContaining({ difference: 3_000, value: 1_500 }),
        ],
      }),
    );
    expect(() => s.business.postStockCount({ date: "2026-01-31", warehouseId: s.main, memo: "", lines: [] })).toThrow(
      expect.objectContaining({ code: "count_needs_lines" }),
    );
  });

  test("a write-off takes stock out of one warehouse with a reason: Dr Stock loss, Cr Stock", () => {
    const s = setup();
    s.buy("2026-01-01", s.router, 10, 60_000);
    s.business.writeOffStock({
      date: "2026-01-10",
      warehouseId: s.main,
      reason: "تالف من النقل",
      lines: [{ itemId: s.router, unit: "base", quantity: 1_000 }],
    });
    expect(s.business.stockOnHand(s.router).total).toBe(9_000);
    expect(balanceOf(s.business, "stock_loss")).toBe(60_000);
    expect(s.business.writeOffs()[0]).toEqual(expect.objectContaining({ reason: "تالف من النقل", value: 60_000 }));
    expect(() =>
      s.business.writeOffStock({
        date: "2026-01-10",
        warehouseId: s.branch,
        reason: "تالف",
        lines: [{ itemId: s.router, unit: "base", quantity: 1_000 }],
      }),
    ).toThrow(expect.objectContaining({ code: "stock_insufficient" }));
    expect(() =>
      s.business.writeOffStock({
        date: "2026-01-10",
        warehouseId: s.main,
        reason: " ",
        lines: [{ itemId: s.router, unit: "base", quantity: 1_000 }],
      }),
    ).toThrow(expect.objectContaining({ code: "reason_required" }));
  });
});

describe("low stock and movement history", () => {
  test("items below their minimum are listed, in total or for one warehouse", () => {
    const s = setup();
    s.buy("2026-01-01", s.router, 3, 60_000);
    s.buy("2026-01-01", s.router, 4, 60_000, s.branch);
    s.buy("2026-01-01", s.cable, 100, 500);
    s.business.setItemMinimum(s.router, 5_000);
    s.business.setItemMinimum(s.cable, 50_000);
    expect(s.business.lowStock().map((r) => [r.nameAr, r.onHand])).toEqual([]);
    expect(s.business.lowStock(s.main).map((r) => [r.nameAr, r.minQuantity, r.onHand])).toEqual([["راوتر", 5_000, 3_000]]);
    s.sell("2026-01-05", s.router, 3, s.branch);
    expect(s.business.lowStock().map((r) => [r.nameAr, r.onHand])).toEqual([["راوتر", 4_000]]);
    s.business.setItemMinimum(s.router, null);
    expect(s.business.lowStock()).toEqual([]);
  });

  test("an item's movements, with a running balance, for all warehouses or one", () => {
    const s = setup();
    s.buy("2026-01-01", s.router, 10, 60_000);
    s.business.transferStock({
      date: "2026-01-02",
      from: s.main,
      to: s.branch,
      memo: "",
      lines: [{ itemId: s.router, unit: "base", quantity: 4_000 }],
    });
    s.sell("2026-01-03", s.router, 1, s.branch);
    expect(s.business.itemMovements(s.router).map((m) => [m.source, m.warehouseName, m.quantity, m.balance])).toEqual([
      ["purchase", "المخزن الرئيسي", 10_000, 10_000],
      ["transfer", "المخزن الرئيسي", -4_000, 6_000],
      ["transfer", "فرع المعادي", 4_000, 10_000],
      ["sales_invoice", "فرع المعادي", -1_000, 9_000],
    ]);
    expect(s.business.itemMovements(s.router, s.branch).map((m) => [m.quantity, m.balance])).toEqual([
      [4_000, 4_000],
      [-1_000, 3_000],
    ]);
  });
});

describe("back-dated cost", () => {
  test("a back-dated purchase reprices the sales after it and adjusts cost of sales", () => {
    const s = setup();
    s.buy("2026-01-01", s.router, 10, 60_000);
    s.sell("2026-01-10", s.router, 10);
    // Bought before the sale but entered after: the sale took 10 at 600.00; with 10 more at 900.00 held
    // first, the average on the 10th is 750.00.
    s.buy("2026-01-05", s.router, 10, 90_000);
    expect(balanceOf(s.business, "cost_of_goods_sold")).toBe(750_000);
    expect(balanceOf(s.business, "stock")).toBe(750_000);
    expect(s.business.stockValue(s.router)).toBe(750_000);
    expect(s.business.averageCost(s.router)).toBe(75_000);
  });

  test("a back-dated sale takes the average as it was on its date", () => {
    const s = setup();
    s.buy("2026-01-01", s.router, 10, 60_000);
    s.buy("2026-01-20", s.router, 10, 90_000);
    s.sell("2026-01-10", s.router, 5);
    expect(balanceOf(s.business, "cost_of_goods_sold")).toBe(300_000);
    expect(s.business.stockValue(s.router)).toBe(1_200_000);
  });

  test("random purchases, sales, transfers, counts and back-dated entries keep the Stock account equal to the stock value", () => {
    let seed = 20261121;
    const random = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    for (let run = 0; run < 15; run++) {
      const s = setup();
      const items = [s.router, s.cable];
      const warehouses = [s.main, s.branch];
      for (let step = 0; step < 30; step++) {
        const date = `2026-0${1 + random(3)}-${String(1 + random(28)).padStart(2, "0")}`;
        const item = items[random(2)]!;
        const warehouse = warehouses[random(2)]!;
        const held = s.business.stockOnHand(item).byWarehouse.find((w) => w.warehouseId === warehouse)?.quantity ?? 0;
        const kind = random(5);
        if (kind <= 1) s.buy(date, item, 1 + random(9), 1_000 + random(90_000), warehouse);
        else if (kind === 2) s.sell(date, item, 1 + random(5), warehouse);
        else if (kind === 3 && held >= 1_000) {
          const other = warehouses.find((w) => w !== warehouse)!;
          s.business.transferStock({ date, from: warehouse, to: other, memo: "", lines: [{ itemId: item, unit: "base", quantity: 1_000 }] });
        } else if (kind === 4)
          s.business.postStockCount({
            date,
            warehouseId: warehouse,
            memo: "",
            lines: [{ itemId: item, counted: Math.max(0, held - 1_000 + random(3) * 1_000) }],
          });
      }
      const value = items.reduce((t, i) => t + s.business.stockValue(i), 0);
      expect(balanceOf(s.business, "stock"), `run ${run}`).toBe(value);
    }
  });
});
