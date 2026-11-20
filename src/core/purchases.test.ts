import { describe, expect, test } from "vitest";
import { Business } from "./business";

const manager = { name: "أيمن", password: "كلمة سر قوية" };
const shop = { name: "شركة النور للكمبيوتر", address: "الدقي", taxRegistrationNumber: "", vatRegistered: true, fiscalYearStartMonth: 1 };

function setup(settings = shop) {
  const business = Business.create(":memory:", settings, manager);
  const main = business.warehouses()[0]!.id;
  const codes = business.taxCodes();
  const standard = codes.find((c) => c.kind === "standard")!.id;
  const exempt = codes.find((c) => c.kind === "exempt")!.id;
  const router = business.addItem({
    nameAr: "راوتر",
    baseUnit: "قطعة",
    salePrice: 150_000,
    taxCodeId: standard,
    pack: { name: "كرتونة", size: 12_000, salePrice: 1_700_000 },
  });
  const book = business.addItem({ nameAr: "كتاب", baseUnit: "قطعة", salePrice: 5_000, taxCodeId: exempt });
  const supplier = business.addSupplier({ name: "شركة الشبكات المتحدة", phone: "0100", taxRegistrationNumber: "123456789" });
  return { business, main, router, book, supplier };
}

function balanceOf(business: Business, role: string, asOf = "2026-12-31") {
  const account = business.accounts().find((a) => a.role === role)!;
  const row = business.trialBalance(asOf).rows.find((r) => r.accountId === account.id);
  return row ? row.debit - row.credit : 0;
}

describe("suppliers", () => {
  test("suppliers are added, listed and renamed; names are unique and required", () => {
    const { business, supplier } = setup();
    const other = business.addSupplier({ name: "مؤسسة الحاسب", phone: "", taxRegistrationNumber: "" });

    business.updateSupplier(other, { name: "مؤسسة الحاسب الآلي" });

    expect(business.suppliers().map((s) => s.name)).toEqual(["شركة الشبكات المتحدة", "مؤسسة الحاسب الآلي"]);
    expect(business.suppliers()[0]).toEqual(expect.objectContaining({ id: supplier, phone: "0100", taxRegistrationNumber: "123456789", active: true }));
    expect(() => business.addSupplier({ name: "مؤسسة الحاسب الآلي", phone: "", taxRegistrationNumber: "" })).toThrow(
      expect.objectContaining({ code: "supplier_name_taken" }),
    );
    expect(() => business.addSupplier({ name: " ", phone: "", taxRegistrationNumber: "" })).toThrow(
      expect.objectContaining({ code: "supplier_name_required" }),
    );
    expect(() => business.addSupplier({ name: "س", phone: "", taxRegistrationNumber: "12" })).toThrow(
      expect.objectContaining({ code: "tax_registration_number_invalid" }),
    );
  });

  test("a stopped supplier cannot be bought from", () => {
    const { business, main, router, supplier } = setup();
    business.deactivateSupplier(supplier);

    expect(() =>
      business.postPurchaseInvoice({
        date: "2026-03-01",
        supplierId: supplier,
        warehouseId: main,
        reference: "",
        lines: [{ itemId: router, unit: "base", quantity: 1_000, unitPrice: 100_000 }],
      }),
    ).toThrow(expect.objectContaining({ code: "supplier_inactive" }));
  });
});

describe("purchase invoices", () => {
  test("posting raises stock and posts Dr Stock, Dr Input VAT, Cr Payables for the supplier", () => {
    const { business, main, router, book, supplier } = setup();

    const id = business.postPurchaseInvoice({
      date: "2026-03-01",
      supplierId: supplier,
      warehouseId: main,
      reference: "INV-77",
      lines: [
        { itemId: router, unit: "base", quantity: 10_000, unitPrice: 100_000 },
        { itemId: book, unit: "base", quantity: 3_000, unitPrice: 4_000 },
      ],
    });

    // Router: 10 × 1,000.00 = 10,000.00 net, 14% VAT = 1,400.00. Book: exempt, 120.00.
    expect(balanceOf(business, "stock")).toBe(1_000_000 + 12_000);
    expect(balanceOf(business, "input_vat")).toBe(140_000);
    expect(balanceOf(business, "payables")).toBe(-(1_012_000 + 140_000));
    expect(business.supplierBalance(supplier)).toBe(1_152_000);
    expect(business.stockOnHand(router)).toEqual(
      expect.objectContaining({ total: 10_000, byWarehouse: [{ warehouseId: main, quantity: 10_000 }] }),
    );
    expect(business.purchaseInvoices()).toEqual([
      expect.objectContaining({ id, date: "2026-03-01", supplierId: supplier, reference: "INV-77", net: 1_012_000, vat: 140_000, total: 1_152_000, postedBy: "أيمن" }),
    ]);
  });

  test("VAT is rounded half-up on each line", () => {
    const { business, main, router, supplier } = setup();

    // 3 × 0.25 = 0.75 net; 14% of 75 piastres = 10.5 → 11.
    business.postPurchaseInvoice({
      date: "2026-03-01",
      supplierId: supplier,
      warehouseId: main,
      reference: "",
      lines: [{ itemId: router, unit: "base", quantity: 3_000, unitPrice: 25 }],
    });

    expect(balanceOf(business, "input_vat")).toBe(11);
    expect(business.purchaseInvoices()[0]!.lines[0]).toEqual(expect.objectContaining({ net: 75, vatRate: 1400, vat: 11 }));
  });

  test("a business that is not VAT-registered puts the whole cost into stock", () => {
    const { business, main, router, supplier } = setup({ ...shop, vatRegistered: false });

    business.postPurchaseInvoice({
      date: "2026-03-01",
      supplierId: supplier,
      warehouseId: main,
      reference: "",
      lines: [{ itemId: router, unit: "base", quantity: 1_000, unitPrice: 100_000 }],
    });

    expect(balanceOf(business, "input_vat")).toBe(0);
    expect(business.supplierBalance(supplier)).toBe(100_000);
  });

  test("weighted average cost updates on each purchase, counting packs in base units", () => {
    const { business, main, router, supplier } = setup();
    const other = business.addWarehouse("مخزن المعرض");

    business.postPurchaseInvoice({
      date: "2026-03-01",
      supplierId: supplier,
      warehouseId: main,
      reference: "",
      lines: [{ itemId: router, unit: "base", quantity: 10_000, unitPrice: 100_000 }],
    });
    expect(business.averageCost(router)).toBe(100_000);

    // 5 cartons of 12 at 10,800.00 each: 60 pieces for 54,000.00, into another warehouse.
    business.postPurchaseInvoice({
      date: "2026-03-05",
      supplierId: supplier,
      warehouseId: other,
      reference: "",
      lines: [{ itemId: router, unit: "pack", quantity: 5_000, unitPrice: 1_080_000 }],
    });

    // (10 × 1,000.00 + 54,000.00) / 70 = 914.2857… → 914.29
    expect(business.averageCost(router)).toBe(91_429);
    expect(business.stockOnHand(router).total).toBe(70_000);
    expect(balanceOf(business, "stock")).toBe(6_400_000);
  });

  test("lines can be priced before posting, and pricing writes nothing", () => {
    const { business, router, book } = setup();

    const priced = business.pricePurchase("2026-03-01", [
      { itemId: router, unit: "pack", quantity: 2_000, unitPrice: 1_080_000 },
      { itemId: book, unit: "base", quantity: 1_000, unitPrice: 4_000 },
    ]);

    expect(priced).toEqual({
      lines: [
        expect.objectContaining({ net: 2_160_000, vatRate: 1400, vat: 302_400 }),
        expect.objectContaining({ net: 4_000, vatRate: 0, vat: 0 }),
      ],
      net: 2_164_000,
      vat: 302_400,
      total: 2_466_400,
    });
    expect(business.stockOnHand(router).total).toBe(0);
  });

  test("an item never bought has no average cost", () => {
    const { business, book } = setup();

    expect(business.averageCost(book)).toBe(0);
  });

  test("bad invoices are refused and nothing is written", () => {
    const { business, main, router, book, supplier } = setup();
    const base = { date: "2026-03-01", supplierId: supplier, warehouseId: main, reference: "" };

    expect(() => business.postPurchaseInvoice({ ...base, lines: [] })).toThrow(expect.objectContaining({ code: "invoice_needs_lines" }));
    expect(() =>
      business.postPurchaseInvoice({ ...base, lines: [{ itemId: router, unit: "base", quantity: 1_000, unitPrice: -1 }] }),
    ).toThrow(expect.objectContaining({ code: "price_invalid" }));
    expect(() =>
      business.postPurchaseInvoice({ ...base, lines: [{ itemId: book, unit: "pack", quantity: 1_000, unitPrice: 1 }] }),
    ).toThrow(expect.objectContaining({ code: "item_has_no_pack" }));
    expect(() =>
      business.postPurchaseInvoice({ ...base, supplierId: 999, lines: [{ itemId: router, unit: "base", quantity: 1_000, unitPrice: 1 }] }),
    ).toThrow(expect.objectContaining({ code: "supplier_not_found" }));
    expect(() =>
      business.postPurchaseInvoice({
        ...base,
        lines: [
          { itemId: router, unit: "base", quantity: 1_000, unitPrice: 100 },
          { itemId: router, unit: "base", quantity: 0, unitPrice: 100 },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: "quantity_invalid" }));

    expect(business.purchaseInvoices()).toEqual([]);
    expect(business.stockOnHand(router).total).toBe(0);
    expect(balanceOf(business, "stock")).toBe(0);
  });

  test("a cashier may not post purchases; a storekeeper may", () => {
    const { business, main, router, supplier } = setup();
    business.addUser({ name: "سارة", role: "cashier", password: "123456" });
    business.addUser({ name: "محمود", role: "storekeeper", password: "123456" });
    const invoice = {
      date: "2026-03-01",
      supplierId: supplier,
      warehouseId: main,
      reference: "",
      lines: [{ itemId: router, unit: "base" as const, quantity: 1_000, unitPrice: 100 }],
    };

    expect(() => business.signIn("سارة", "123456").postPurchaseInvoice(invoice)).toThrow(
      expect.objectContaining({ code: "not_allowed" }),
    );
    const storekeeper = business.signIn("محمود", "123456");
    storekeeper.postPurchaseInvoice(invoice);
    expect(business.purchaseInvoices()[0]!.postedBy).toBe("محمود");
  });
});
