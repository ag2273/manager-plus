import { describe, expect, test } from "vitest";
import { Business } from "./business";

const manager = { name: "أيمن", password: "كلمة سر قوية" };
const shop = { name: "شركة النور للاستيراد", address: "", taxRegistrationNumber: "", vatRegistered: true, fiscalYearStartMonth: 1 };

function setup() {
  const business = Business.create(":memory:", shop, manager);
  const main = business.warehouses()[0]!.id;
  const standard = business.taxCodes().find((c) => c.kind === "standard")!.id;
  const router = business.addItem({ nameAr: "راوتر", baseUnit: "قطعة", salePrice: 900_000, taxCodeId: standard });
  const sw = business.addItem({ nameAr: "سويتش", baseUnit: "قطعة", salePrice: 200_000, taxCodeId: standard });
  const shenzhen = business.addSupplier({ name: "Shenzhen Networks", phone: "", taxRegistrationNumber: "", currency: "USD" });
  const customs = business.addSupplier({ name: "مصلحة الجمارك", phone: "", taxRegistrationNumber: "" });
  const freight = business.addSupplier({ name: "شركة الشحن السريع", phone: "", taxRegistrationNumber: "" });
  const customer = business.addCustomer({ name: "شركة الأمل", phone: "", taxRegistrationNumber: "" });
  const account = (role: string) => business.accounts().find((a) => a.role === role)!.id;
  // 10 routers at USD 100 (EGP 50,000) and 20 switches at USD 25 (EGP 25,000), at 50.00.
  const invoice = business.postPurchaseInvoice({
    date: "2026-03-01",
    supplierId: shenzhen,
    warehouseId: main,
    reference: "SZ-7",
    rate: 50_000_000,
    lines: [
      { itemId: router, unit: "base", quantity: 10_000, unitPrice: 10_000 },
      { itemId: sw, unit: "base", quantity: 20_000, unitPrice: 2_500 },
    ],
  });
  const costs = [
    { kind: "customs_duty" as const, payeeId: customs, amount: 750_000, vat: 1_155_000 },
    { kind: "freight" as const, payeeId: freight, amount: 300_000, vat: 0 },
  ];
  return { business, main, router, sw, shenzhen, customs, freight, customer, account, invoice, costs };
}

function balanceOf(business: Business, role: string) {
  const account = business.accounts().find((a) => a.role === role)!;
  const row = business.trialBalance("2026-12-31").rows.find((r) => r.accountId === account.id);
  return row ? row.debit - row.credit : 0;
}

describe("import shipments", () => {
  test("customs and freight are spread by value into the items' cost, and customs VAT is input VAT", () => {
    const s = setup();
    s.business.postImportShipment({ date: "2026-03-10", reference: "BL-1", purchaseInvoiceIds: [s.invoice], spreadBy: "value", costs: s.costs });

    // EGP 10,500 of costs over goods of 50,000 + 25,000: routers take 7,000, switches 3,500.
    expect(balanceOf(s.business, "stock")).toBe(7_500_000 + 1_050_000);
    expect(balanceOf(s.business, "input_vat")).toBe(1_155_000);
    expect(s.business.supplierBalance(s.customs)).toBe(1_905_000);
    expect(s.business.supplierBalance(s.freight)).toBe(300_000);
    expect(s.business.averageCost(s.router)).toBe(570_000);
    expect(s.business.averageCost(s.sw)).toBe(142_500);

    const [shipment] = s.business.importShipments();
    expect(shipment).toEqual(
      expect.objectContaining({ number: 1, reference: "BL-1", spreadBy: "value", goods: 7_500_000, costs: 1_050_000, vat: 1_155_000 }),
    );
    expect(shipment!.lines.map((l) => [l.nameAr, l.quantity, l.goods, l.allocated, l.landedUnitCost])).toEqual([
      ["راوتر", 10_000, 5_000_000, 700_000, 570_000],
      ["سويتش", 20_000, 2_500_000, 350_000, 142_500],
    ]);
  });

  test("spread by quantity, with the rounding remainder on the largest line so the total matches exactly", () => {
    const s = setup();
    s.business.postImportShipment({
      date: "2026-03-10",
      reference: "",
      purchaseInvoiceIds: [s.invoice],
      spreadBy: "quantity",
      costs: [{ kind: "clearance", payeeId: s.freight, amount: 100_001, vat: 0 }],
    });
    // 30 units: routers 10/30 → 33,333.67 → 33,334; switches 66,667.33 → 66,667, and the rounding leaves nothing over.
    const [shipment] = s.business.importShipments();
    expect(shipment!.lines.map((l) => l.allocated)).toEqual([33_334, 66_667]);
    expect(balanceOf(s.business, "stock")).toBe(7_500_000 + 100_001);
  });

  test("the part of the costs for units already sold goes to cost of goods sold", () => {
    const s = setup();
    s.business.postSalesInvoice({
      date: "2026-03-05",
      customerId: s.customer,
      warehouseId: s.main,
      reference: "",
      notes: "",
      lines: [{ itemId: s.router, unit: "base", quantity: 4_000, unitPrice: 900_000 }],
    });
    const cogsBefore = balanceOf(s.business, "cost_of_goods_sold");
    s.business.postImportShipment({ date: "2026-03-10", reference: "", purchaseInvoiceIds: [s.invoice], spreadBy: "value", costs: s.costs });

    // Routers take 7,000; 4 of the 10 are sold, so 2,800 goes to cost of sales and 4,200 to the 6 still held.
    expect(balanceOf(s.business, "cost_of_goods_sold") - cogsBefore).toBe(280_000);
    expect(s.business.averageCost(s.router)).toBe(570_000);
    expect(balanceOf(s.business, "stock")).toBe(7_500_000 - 2_000_000 + 1_050_000 - 280_000);
  });

  test("an invoice goes into one shipment only, payees bill in EGP, and a shipment needs costs", () => {
    const s = setup();
    const post = (over: object) =>
      s.business.postImportShipment({ date: "2026-03-10", reference: "", purchaseInvoiceIds: [s.invoice], spreadBy: "value", costs: s.costs, ...over });
    expect(() => post({ costs: [] })).toThrow(expect.objectContaining({ code: "shipment_needs_costs" }));
    expect(() => post({ purchaseInvoiceIds: [] })).toThrow(expect.objectContaining({ code: "shipment_needs_invoices" }));
    expect(() => post({ costs: [{ kind: "freight", payeeId: s.shenzhen, amount: 1_000, vat: 0 }] })).toThrow(
      expect.objectContaining({ code: "payee_not_egp" }),
    );
    expect(() => post({ costs: [{ kind: "freight", payeeId: s.freight, amount: -5, vat: 0 }] })).toThrow(expect.objectContaining({ code: "amount_invalid" }));
    post({});
    expect(() => post({})).toThrow(expect.objectContaining({ code: "invoice_in_shipment" }));
  });
});
