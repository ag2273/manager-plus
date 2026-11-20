import { describe, expect, test } from "vitest";
import { Business } from "./business";
import { saleDocument } from "../shared/receipt";
import { addMonths } from "./serials";

const manager = { name: "أيمن", password: "كلمة سر قوية" };
const shop = { name: "شركة النور للكمبيوتر", address: "", taxRegistrationNumber: "", vatRegistered: true, fiscalYearStartMonth: 1 };

function setup() {
  const business = Business.create(":memory:", shop, manager);
  const main = business.warehouses()[0]!.id;
  const branch = business.addWarehouse("فرع مدينة نصر");
  const standard = business.taxCodes().find((c) => c.kind === "standard")!.id;
  const laptop = business.addItem({ nameAr: "لابتوب", baseUnit: "قطعة", barcode: "6221000000500", salePrice: 2_000_000, taxCodeId: standard });
  business.setItemSerials(laptop, { serialised: true, warrantyMonths: 12 });
  const cable = business.addItem({ nameAr: "كابل", baseUnit: "متر", salePrice: 1_000, taxCodeId: standard });
  const supplier = business.addSupplier({ name: "Dell Egypt", phone: "", taxRegistrationNumber: "" });
  const customer = business.addCustomer({ name: "شركة الأمل", phone: "", taxRegistrationNumber: "" });
  const buy = (serials: string[], date = "2026-01-10") =>
    business.postPurchaseInvoice({
      date,
      supplierId: supplier,
      warehouseId: main,
      reference: "D-1",
      lines: [{ itemId: laptop, unit: "base", quantity: serials.length * 1_000, unitPrice: 1_500_000, serials }],
    });
  return { business, main, branch, laptop, cable, supplier, customer, buy };
}

const sale = (s: ReturnType<typeof setup>, serials: string[], customerId?: number) => {
  if (!s.business.currentShift()) s.business.openShift(0);
  return s.business.postSale({
    date: "2026-03-31",
    warehouseId: s.main,
    lines: [{ itemId: s.laptop, unit: "base", quantity: serials.length * 1_000, serials }],
    payments: [{ method: "cash", amount: 2_000_000 * serials.length }],
    ...(customerId === undefined ? {} : { customerId }),
  });
};

describe("serial numbers", () => {
  test("a purchase needs exactly one different serial per whole unit", () => {
    const s = setup();

    s.buy(["A1"]);
    expect(() =>
      s.business.postPurchaseInvoice({
        date: "2026-01-10",
        supplierId: s.supplier,
        warehouseId: s.main,
        reference: "",
        lines: [{ itemId: s.laptop, unit: "base", quantity: 2_000, unitPrice: 100, serials: ["D1"] }],
      }),
    ).toThrow(expect.objectContaining({ code: "serials_required" }));
    expect(() => s.buy(["B1", "B1"])).toThrow(expect.objectContaining({ code: "serials_required" }));
    expect(() =>
      s.business.postPurchaseInvoice({
        date: "2026-01-10",
        supplierId: s.supplier,
        warehouseId: s.main,
        reference: "",
        lines: [{ itemId: s.laptop, unit: "base", quantity: 1_500, unitPrice: 100, serials: ["C1"] }],
      }),
    ).toThrow(expect.objectContaining({ code: "serials_required" }));
    expect(() =>
      s.business.postPurchaseInvoice({
        date: "2026-01-10",
        supplierId: s.supplier,
        warehouseId: s.main,
        reference: "",
        lines: [{ itemId: s.cable, unit: "base", quantity: 1_000, unitPrice: 100, serials: ["X"] }],
      }),
    ).toThrow(expect.objectContaining({ code: "serials_not_expected" }));
    expect(() => s.buy(["A1"])).toThrow(expect.objectContaining({ code: "serial_in_stock" }));
    expect(s.business.stockOnHand(s.laptop).total).toBe(1_000);
  });

  test("a sold unit shows its supplier, customer and warranty, and only units in stock can be sold", () => {
    const s = setup();
    s.buy(["SN-1", "SN-2"]);

    sale(s, ["SN-1"], s.customer);

    const [history] = s.business.findSerial("SN-1", "2026-06-01");
    expect(history).toEqual({
      itemId: s.laptop,
      nameAr: "لابتوب",
      serial: "SN-1",
      inStock: false,
      warehouseId: null,
      purchase: { date: "2026-01-10", supplierId: s.supplier, supplierName: "Dell Egypt", reference: "D-1" },
      sale: { date: "2026-03-31", document: "إيصال 1", customerId: s.customer, customerName: "شركة الأمل" },
      warrantyEnds: "2027-03-31",
      underWarranty: true,
    });
    expect(s.business.findSerial("SN-1", "2027-04-01")[0]!.underWarranty).toBe(false);
    expect(s.business.findSerial("SN-2", "2026-06-01")[0]).toEqual(expect.objectContaining({ inStock: true, warehouseId: s.main, sale: null }));
    expect(s.business.findReceipt(1).lines[0]).toEqual(expect.objectContaining({ serials: ["SN-1"], warrantyEnds: "2027-03-31" }));
    expect(saleDocument(s.business.findReceipt(1), s.business.settings(), { footer: "", copy: false }).lines[0]!.name).toBe(
      "لابتوب\nS/N: SN-1\nضمان حتى 2027-03-31",
    );
    expect(() => sale(s, ["SN-1"])).toThrow(expect.objectContaining({ code: "serial_not_in_stock" }));
    expect(() => sale(s, ["NOPE"])).toThrow(expect.objectContaining({ code: "serial_not_in_stock" }));
  });

  test("a unit comes back only against the sale it left on, and can then be sold again", () => {
    const s = setup();
    s.buy(["SN-1", "SN-2"]);
    const first = sale(s, ["SN-1"]);
    const second = sale(s, ["SN-2"]);
    const line = (n: number) => s.business.findReceipt(n).lines[0]!.lineId;

    expect(() =>
      s.business.returnSale({ date: "2026-04-01", receiptId: second.id, lines: [{ lineId: line(2), quantity: 1_000, serials: ["SN-1"] }], refund: "cash" }),
    ).toThrow(expect.objectContaining({ code: "serial_not_on_document" }));

    s.business.returnSale({ date: "2026-04-01", receiptId: first.id, lines: [{ lineId: line(1), quantity: 1_000, serials: ["SN-1"] }], refund: "cash" });

    expect(s.business.findSerial("SN-1", "2026-04-02")[0]).toEqual(expect.objectContaining({ inStock: true, warehouseId: s.main, sale: null }));
    expect(sale(s, ["SN-1"]).number).toBe(3);
  });

  test("transfers move each serial between warehouses; invoices, credit and debit notes carry serials too", () => {
    const s = setup();
    const purchase = s.buy(["SN-1", "SN-2", "SN-3"]);

    s.business.transferStock({ date: "2026-02-01", from: s.main, to: s.branch, memo: "", lines: [{ itemId: s.laptop, unit: "base", quantity: 1_000, serials: ["SN-3"] }] });
    expect(s.business.findSerial("SN-3", "2026-02-02")[0]!.warehouseId).toBe(s.branch);
    expect(() =>
      s.business.transferStock({ date: "2026-02-01", from: s.main, to: s.branch, memo: "", lines: [{ itemId: s.laptop, unit: "base", quantity: 1_000, serials: ["SN-3"] }] }),
    ).toThrow(expect.objectContaining({ code: "serial_not_in_stock" }));

    const invoice = s.business.postSalesInvoice({
      date: "2026-02-10",
      customerId: s.customer,
      warehouseId: s.main,
      reference: "",
      notes: "",
      lines: [{ itemId: s.laptop, unit: "base", quantity: 1_000, unitPrice: 1_800_000, serials: ["SN-1"] }],
    });
    expect(s.business.findSalesInvoice(invoice.number).lines[0]).toEqual(expect.objectContaining({ serials: ["SN-1"], warrantyEnds: "2027-02-10" }));
    expect(s.business.findSerial("SN-1", "2026-03-01")[0]!.sale).toEqual(expect.objectContaining({ document: "فاتورة 1", customerName: "شركة الأمل" }));
    const invoiceLine = s.business.findSalesInvoice(invoice.number).lines[0]!.lineId;
    s.business.postCreditNote({ date: "2026-02-12", invoiceId: invoice.id, reason: "", lines: [{ lineId: invoiceLine, quantity: 1_000, serials: ["SN-1"] }] });
    expect(s.business.findSerial("SN-1", "2026-03-01")[0]!.inStock).toBe(true);

    const purchaseLine = s.business.purchaseInvoices()[0]!.lines[0]!.lineId;
    s.business.postDebitNote({ date: "2026-02-15", purchaseInvoiceId: purchase, reason: "", lines: [{ lineId: purchaseLine, quantity: 1_000, serials: ["SN-2"] }] });
    expect(s.business.findSerial("SN-2", "2026-03-01")[0]).toEqual(expect.objectContaining({ inStock: false, sale: null }));
    expect(s.business.stockOnHand(s.laptop).total).toBe(2_000);
  });

  test("serial tracking can be switched only while no unserialised stock is held", () => {
    const s = setup();
    s.business.postOpeningStock("2026-01-01", s.main, [{ itemId: s.cable, quantity: 5_000, unitCost: 100 }]);

    expect(() => s.business.setItemSerials(s.cable, { serialised: true, warrantyMonths: 0 })).toThrow(expect.objectContaining({ code: "serial_setting_locked" }));
    s.buy(["SN-1"]);
    expect(() => s.business.setItemSerials(s.laptop, { serialised: false, warrantyMonths: 0 })).toThrow(expect.objectContaining({ code: "serial_setting_locked" }));
    s.business.setItemSerials(s.laptop, { serialised: true, warrantyMonths: 24 });
    expect(s.business.items().find((i) => i.id === s.laptop)).toEqual(expect.objectContaining({ serialised: true, warrantyMonths: 24 }));
    expect(() => s.business.setItemSerials(s.laptop, { serialised: true, warrantyMonths: -1 })).toThrow(expect.objectContaining({ code: "warranty_invalid" }));
  });

  test("warranty months land on the same day, or the month's last day", () => {
    expect(addMonths("2026-03-31", 12)).toBe("2027-03-31");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2027-11-30", 3)).toBe("2028-02-29");
  });
});
