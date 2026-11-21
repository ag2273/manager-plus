import { describe, expect, test } from "vitest";
import { Business, type BusinessSettings } from "./business";

const manager = { name: "أيمن", password: "كلمة سر قوية" };

const shop: BusinessSettings = {
  name: "بقالة النور",
  address: "الدقي",
  taxRegistrationNumber: "",
  vatRegistered: true,
  fiscalYearStartMonth: 1,
};

function newShop(settings: Partial<BusinessSettings> = {}): Business {
  return Business.create(":memory:", { ...shop, ...settings }, manager);
}

function taxCode(business: Business, kind: "standard" | "zero_rated" | "exempt") {
  const found = business.taxCodes().find((t) => t.kind === kind);
  if (!found) throw new Error(`no tax code ${kind}`);
  return found;
}

function dishSoap(business: Business) {
  return {
    nameAr: "منظف أطباق 1 لتر",
    nameEn: "Dish soap 1 L",
    code: "A-100",
    baseUnit: "قطعة",
    barcode: "6221000000035",
    salePrice: 5_700,
    taxCodeId: taxCode(business, "standard").id,
    egsCode: "EG-123-456",
  };
}

describe("tax codes", () => {
  test("a new business has standard 14%, zero-rated and exempt tax codes", () => {
    const business = newShop();

    expect(business.taxCodes().map((t) => [t.kind, t.name])).toEqual([
      ["standard", "ضريبة قيمة مضافة 14%"],
      ["zero_rated", "خاضع بنسبة صفر"],
      ["exempt", "معفى"],
    ]);
    expect(business.vatRate(taxCode(business, "standard").id, "2026-11-20")).toBe(1_400);
    expect(business.vatRate(taxCode(business, "zero_rated").id, "2026-11-20")).toBe(0);
    expect(business.vatRate(taxCode(business, "exempt").id, "2026-11-20")).toBe(0);
  });

  test("the rate used is the one in force on the document date", () => {
    const business = newShop();
    const standard = taxCode(business, "standard").id;

    business.addTaxRate(standard, { from: "2027-01-01", rate: 1_500 });

    expect(business.vatRate(standard, "2026-12-31")).toBe(1_400);
    expect(business.vatRate(standard, "2027-01-01")).toBe(1_500);
  });

  test("when the business is not VAT-registered every rate is zero", () => {
    const business = newShop({ vatRegistered: false });

    expect(business.vatRate(taxCode(business, "standard").id, "2026-11-20")).toBe(0);
  });

  test("a rate must be whole basis points between 0% and 100%", () => {
    const business = newShop();
    const standard = taxCode(business, "standard").id;

    for (const rate of [-1, 10_001, 14.5]) {
      expect(() => business.addTaxRate(standard, { from: "2027-01-01", rate })).toThrow(
        expect.objectContaining({ code: "tax_rate_invalid" }),
      );
    }
    expect(() => business.addTaxRate(standard, { from: "2027-02-30", rate: 1_500 })).toThrow(
      expect.objectContaining({ code: "date_invalid" }),
    );
  });
});

describe("items", () => {
  test("the owner creates an item and sees it in the item list", () => {
    const business = newShop();

    const id = business.addItem(dishSoap(business));

    expect(business.items()).toEqual([
      {
        id,
        nameAr: "منظف أطباق 1 لتر",
        nameEn: "Dish soap 1 L",
        code: "A-100",
        baseUnit: "قطعة",
        barcode: "6221000000035",
        salePrice: 5_700,
        wholesalePrice: null,
        taxCodeId: taxCode(business, "standard").id,
        egsCode: "EG-123-456",
        pack: null,
        serialised: false,
        warrantyMonths: 0,
        active: true,
      },
    ]);
  });

  test("an item can have a pack unit with its own barcode and price", () => {
    const business = newShop();

    const id = business.addItem({
      ...dishSoap(business),
      pack: { name: "كرتونة", size: 12_000, barcode: "16221000000035", salePrice: 64_800 },
    });

    expect(business.items().find((i) => i.id === id)?.pack).toEqual({
      name: "كرتونة",
      size: 12_000,
      barcode: "16221000000035",
      salePrice: 64_800,
      wholesalePrice: null,
    });
  });

  test("scanning a barcode finds the item and the unit, with its size in base units", () => {
    const business = newShop();
    const id = business.addItem({
      ...dishSoap(business),
      pack: { name: "كرتونة", size: 12_000, barcode: "16221000000035", salePrice: 64_800 },
    });

    expect(business.findByBarcode("6221000000035")).toEqual(
      expect.objectContaining({ itemId: id, unit: "base", unitName: "قطعة", quantity: 1_000, salePrice: 5_700 }),
    );
    expect(business.findByBarcode("16221000000035")).toEqual(
      expect.objectContaining({ itemId: id, unit: "pack", unitName: "كرتونة", quantity: 12_000, salePrice: 64_800 }),
    );
    expect(business.findByBarcode("0000")).toBeNull();
  });

  test("a barcode cannot be used twice, across items and pack units", () => {
    const business = newShop();
    business.addItem({
      ...dishSoap(business),
      pack: { name: "كرتونة", size: 12_000, barcode: "16221000000035", salePrice: 64_800 },
    });
    const other = { ...dishSoap(business), code: "A-200", nameAr: "صابون" };

    expect(() => business.addItem({ ...other, barcode: "6221000000035" })).toThrow(
      expect.objectContaining({ code: "barcode_taken" }),
    );
    expect(() => business.addItem({ ...other, barcode: "16221000000035" })).toThrow(
      expect.objectContaining({ code: "barcode_taken" }),
    );
    expect(() =>
      business.addItem({ ...other, barcode: "1", pack: { name: "كرتونة", size: 6_000, barcode: "1", salePrice: 1 } }),
    ).toThrow(expect.objectContaining({ code: "barcode_taken" }));
    expect(business.items()).toHaveLength(1);
  });

  test("two items cannot share a code", () => {
    const business = newShop();
    business.addItem(dishSoap(business));

    expect(() => business.addItem({ ...dishSoap(business), barcode: "999" })).toThrow(
      expect.objectContaining({ code: "item_code_taken" }),
    );
  });

  test.each([
    ["no Arabic name", { nameAr: " " }, "item_name_required"],
    ["no base unit", { baseUnit: "" }, "item_unit_required"],
    ["a price in fractions of a piastre", { salePrice: 10.5 }, "price_invalid"],
    ["a negative price", { salePrice: -1 }, "price_invalid"],
    ["an unknown tax code", { taxCodeId: 9_999 }, "tax_code_not_found"],
    ["a pack holding no units", { pack: { name: "كرتونة", size: 0, barcode: "", salePrice: 1 } }, "pack_size_invalid"],
    ["a pack with a fractional size", { pack: { name: "كرتونة", size: 1.5, barcode: "", salePrice: 1 } }, "pack_size_invalid"],
    ["a pack without a name", { pack: { name: "", size: 6_000, barcode: "", salePrice: 1 } }, "item_unit_required"],
  ])("an item with %s is refused", (_why, change, code) => {
    const business = newShop();

    expect(() => business.addItem({ ...dishSoap(business), ...change })).toThrow(expect.objectContaining({ code }));
    expect(business.items()).toEqual([]);
  });

  test("an item without a barcode, code or English name is fine", () => {
    const business = newShop();

    const id = business.addItem({ ...dishSoap(business), barcode: "", code: "", nameEn: "" });

    expect(business.items().find((i) => i.id === id)).toEqual(
      expect.objectContaining({ barcode: null, code: null, nameEn: "" }),
    );
  });

  test("an item can be edited, and its pack unit added or removed", () => {
    const business = newShop();
    const id = business.addItem(dishSoap(business));

    business.updateItem(id, { salePrice: 6_000, pack: { name: "كرتونة", size: 12_000, barcode: "1622", salePrice: 70_000 } });
    expect(business.items()[0]).toEqual(expect.objectContaining({ salePrice: 6_000, pack: expect.objectContaining({ barcode: "1622" }) }));
    expect(business.findByBarcode("1622")?.unit).toBe("pack");

    business.updateItem(id, { pack: null });
    expect(business.items()[0]?.pack).toBeNull();
    expect(business.findByBarcode("1622")).toBeNull();
  });

  test("an item can keep its own barcode when edited, but not take another's", () => {
    const business = newShop();
    const first = business.addItem(dishSoap(business));
    business.addItem({ ...dishSoap(business), code: "A-200", barcode: "777" });

    business.updateItem(first, { barcode: "6221000000035", nameAr: "منظف أطباق" });
    expect(() => business.updateItem(first, { barcode: "777" })).toThrow(expect.objectContaining({ code: "barcode_taken" }));
  });

  test("a deactivated item stays on record but is hidden and can't be scanned", () => {
    const business = newShop();
    const id = business.addItem(dishSoap(business));

    business.deactivateItem(id);

    expect(business.items()).toEqual([]);
    expect(business.items({ includeInactive: true })).toEqual([expect.objectContaining({ id, active: false })]);
    expect(business.findByBarcode("6221000000035")).toBeNull();

    business.reactivateItem(id);
    expect(business.findByBarcode("6221000000035")?.itemId).toBe(id);
  });

  test("editing an item that doesn't exist is refused", () => {
    expect(() => newShop().updateItem(42, { salePrice: 1 })).toThrow(expect.objectContaining({ code: "item_not_found" }));
  });

  test.each([
    ["أطباق", true],
    ["dish", true],
    ["DISH", true],
    ["A-100", true],
    ["6221000000035", true],
    ["أرز", false],
  ])("searching for %s", (search, found) => {
    const business = newShop();
    business.addItem(dishSoap(business));

    expect(business.items({ search })).toHaveLength(found ? 1 : 0);
  });
});
