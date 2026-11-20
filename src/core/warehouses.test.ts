import { describe, expect, test } from "vitest";
import { Business } from "./business";

const manager = { name: "أيمن", password: "كلمة سر قوية" };
const shop = { name: "شركة النور للكمبيوتر", address: "الدقي", taxRegistrationNumber: "", vatRegistered: true, fiscalYearStartMonth: 1 };

function setup() {
  const business = Business.create(":memory:", shop, manager);
  const main = business.warehouses()[0]!.id;
  const router = business.addItem({
    nameAr: "راوتر",
    baseUnit: "قطعة",
    barcode: "111",
    salePrice: 150_000,
    taxCodeId: business.taxCodes()[0]!.id,
    pack: { name: "كرتونة", size: 10_000, salePrice: 1_400_000 },
  });
  return { business, main, router };
}

describe("warehouses", () => {
  test("a new business has one main warehouse", () => {
    const { business } = setup();

    expect(business.warehouses()).toEqual([expect.objectContaining({ name: "المخزن الرئيسي", active: true })]);
  });

  test("warehouses can be added and renamed, but names are unique and required", () => {
    const { business } = setup();
    const id = business.addWarehouse("مخزن العتبة");

    business.renameWarehouse(id, "مخزن وسط البلد");

    expect(business.warehouses().map((w) => w.name)).toEqual(["المخزن الرئيسي", "مخزن وسط البلد"]);
    expect(() => business.addWarehouse("المخزن الرئيسي")).toThrow(expect.objectContaining({ code: "warehouse_name_taken" }));
    expect(() => business.addWarehouse(" ")).toThrow(expect.objectContaining({ code: "warehouse_name_required" }));
  });

  test("a warehouse with stock cannot be stopped; an empty one can", () => {
    const { business, main, router } = setup();
    const empty = business.addWarehouse("مخزن فاضي");
    business.postOpeningStock("2026-01-01", main, [{ itemId: router, quantity: 5_000, unitCost: 120_000 }]);

    expect(() => business.deactivateWarehouse(main)).toThrow(expect.objectContaining({ code: "warehouse_has_stock" }));
    business.deactivateWarehouse(empty);
    expect(business.warehouses().find((w) => w.id === empty)?.active).toBe(false);
  });
});

describe("opening stock", () => {
  test("opening stock raises quantity in its warehouse and posts its value against opening balances", () => {
    const { business, main, router } = setup();

    business.postOpeningStock("2026-01-01", main, [{ itemId: router, quantity: 5_000, unitCost: 120_000 }]);

    expect(business.stockOnHand(router)).toEqual({ total: 5_000, byWarehouse: [{ warehouseId: main, quantity: 5_000 }] });
    const tb = business.trialBalance("2026-01-01");
    expect(tb.rows).toEqual([
      expect.objectContaining({ code: "1300", debit: 600_000 }),
      expect.objectContaining({ code: "3900", credit: 600_000 }),
    ]);
  });

  test("unit cost must be whole piastres and quantity positive", () => {
    const { business, main, router } = setup();

    expect(() => business.postOpeningStock("2026-01-01", main, [{ itemId: router, quantity: 0, unitCost: 1 }])).toThrow(
      expect.objectContaining({ code: "quantity_invalid" }),
    );
    expect(() => business.postOpeningStock("2026-01-01", main, [{ itemId: router, quantity: 1_000, unitCost: 1.5 }])).toThrow(
      expect.objectContaining({ code: "price_invalid" }),
    );
  });
});

describe("stock transfers", () => {
  test("moving stock changes each warehouse's quantity but not the total or the books", () => {
    const { business, main, router } = setup();
    const branch = business.addWarehouse("مخزن العتبة");
    business.postOpeningStock("2026-01-01", main, [{ itemId: router, quantity: 30_000, unitCost: 120_000 }]);
    const before = business.trialBalance("2026-12-31");

    business.transferStock({ date: "2026-02-01", from: main, to: branch, memo: "", lines: [{ itemId: router, unit: "pack", quantity: 2_000 }] });

    expect(business.stockOnHand(router)).toEqual({
      total: 30_000,
      byWarehouse: [
        { warehouseId: main, quantity: 10_000 },
        { warehouseId: branch, quantity: 20_000 },
      ],
    });
    expect(business.trialBalance("2026-12-31")).toEqual(before);
  });

  test("a transfer needs two different active warehouses and enough stock in the source", () => {
    const { business, main, router } = setup();
    const branch = business.addWarehouse("مخزن العتبة");
    business.postOpeningStock("2026-01-01", main, [{ itemId: router, quantity: 3_000, unitCost: 120_000 }]);
    const move = (from: number, to: number, quantity: number) =>
      business.transferStock({ date: "2026-02-01", from, to, memo: "", lines: [{ itemId: router, unit: "base", quantity }] });

    expect(() => move(main, main, 1_000)).toThrow(expect.objectContaining({ code: "transfer_same_warehouse" }));
    expect(() => move(main, branch, 4_000)).toThrow(expect.objectContaining({ code: "stock_insufficient" }));
    expect(() => move(main, 999, 1_000)).toThrow(expect.objectContaining({ code: "warehouse_not_found" }));
    expect(business.stockOnHand(router).byWarehouse).toEqual([{ warehouseId: main, quantity: 3_000 }]);
  });

  test("a pack line needs an item that has a pack unit", () => {
    const { business, main } = setup();
    const branch = business.addWarehouse("مخزن العتبة");
    const cable = business.addItem({ nameAr: "كابل", baseUnit: "قطعة", salePrice: 5_000, taxCodeId: business.taxCodes()[0]!.id });
    business.postOpeningStock("2026-01-01", main, [{ itemId: cable, quantity: 3_000, unitCost: 3_000 }]);

    expect(() =>
      business.transferStock({ date: "2026-02-01", from: main, to: branch, memo: "", lines: [{ itemId: cable, unit: "pack", quantity: 1_000 }] }),
    ).toThrow(expect.objectContaining({ code: "item_has_no_pack" }));
  });

  test("a cashier cannot move stock; a storekeeper can", () => {
    const { business, main, router } = setup();
    const branch = business.addWarehouse("مخزن العتبة");
    business.postOpeningStock("2026-01-01", main, [{ itemId: router, quantity: 3_000, unitCost: 120_000 }]);
    business.addUser({ name: "سارة", role: "cashier", password: "123456" });
    business.addUser({ name: "حسن", role: "storekeeper", password: "123456" });
    const transfer = { date: "2026-02-01", from: main, to: branch, memo: "", lines: [{ itemId: router, unit: "base" as const, quantity: 1_000 }] };

    expect(() => business.signIn("سارة", "123456").transferStock(transfer)).toThrow(expect.objectContaining({ code: "not_allowed" }));
    business.signIn("حسن", "123456").transferStock(transfer);
    expect(business.stockOnHand(router).total).toBe(3_000);
  });

  test("transfers are listed newest first with their lines", () => {
    const { business, main, router } = setup();
    const branch = business.addWarehouse("مخزن العتبة");
    business.postOpeningStock("2026-01-01", main, [{ itemId: router, quantity: 3_000, unitCost: 120_000 }]);
    const id = business.transferStock({ date: "2026-02-01", from: main, to: branch, memo: "للفرع", lines: [{ itemId: router, unit: "base", quantity: 1_000 }] });

    expect(business.transfers()).toEqual([
      { id, date: "2026-02-01", from: main, to: branch, memo: "للفرع", lines: [{ itemId: router, quantity: 1_000 }] },
    ]);
  });
});
