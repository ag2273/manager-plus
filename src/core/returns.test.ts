import { describe, expect, test } from "vitest";
import { Business } from "./business";

const manager = { name: "أيمن", password: "كلمة سر قوية" };
const shop = { name: "بقالة النور", address: "الدقي", taxRegistrationNumber: "", vatRegistered: true, fiscalYearStartMonth: 1 };

function setup() {
  const business = Business.create(":memory:", shop, manager);
  const main = business.warehouses()[0]!.id;
  const standard = business.taxCodes().find((c) => c.kind === "standard")!.id;
  const rice = business.addItem({ nameAr: "أرز", baseUnit: "كيس", barcode: "11", salePrice: 3_800, taxCodeId: standard });
  const soap = business.addItem({ nameAr: "منظف", baseUnit: "قطعة", barcode: "35", salePrice: 5_700, taxCodeId: standard });
  const supplier = business.addSupplier({ name: "المورد", phone: "", taxRegistrationNumber: "" });
  business.postPurchaseInvoice({
    date: "2026-11-01",
    supplierId: supplier,
    warehouseId: main,
    reference: "",
    lines: [
      { itemId: rice, unit: "base", quantity: 30_000, unitPrice: 3_001 },
      { itemId: soap, unit: "base", quantity: 10_000, unitPrice: 4_000 },
    ],
  });
  business.openShift(0);
  // Receipt 1: 3 rice with 1.00 off the receipt, 1 soap. Lines: 114.00 and 57.00 = 171.00, less 1.00.
  const sale = business.postSale({
    date: "2026-11-20",
    warehouseId: main,
    lines: [
      { itemId: rice, unit: "base", quantity: 3_000 },
      { itemId: soap, unit: "base", quantity: 1_000 },
    ],
    discount: { kind: "amount", value: 100 },
    payments: [{ method: "cash", amount: 17_000 }],
  });
  const receipt = business.findReceipt(sale.number);
  return { business, main, rice, soap, receipt };
}

function balanceOf(business: Business, role: string) {
  const account = business.accounts().find((a) => a.role === role)!;
  const row = business.trialBalance("2026-12-31").rows.find((r) => r.accountId === account.id);
  return row ? row.debit - row.credit : 0;
}

function expectBooksBalance(business: Business, items: number[]) {
  const tb = business.trialBalance("2026-12-31");
  expect(tb.totalDebit).toBe(tb.totalCredit);
  expect(balanceOf(business, "stock")).toBe(items.reduce((t, id) => t + business.stockValue(id), 0));
}

describe("returns", () => {
  test("a receipt is found by its number, with what can still be returned", () => {
    const { business, rice, receipt } = setup();

    expect(receipt.number).toBe(1);
    expect(receipt.lines[0]).toEqual(expect.objectContaining({ itemId: rice, quantity: 3_000, returned: 0, amount: 11_333 }));
    expect(() => business.findReceipt(99)).toThrow(expect.objectContaining({ code: "receipt_not_found" }));
  });

  test("returning reverses sales, VAT, cost and stock at the original values, refunded in cash", () => {
    const { business, rice, soap, receipt } = setup();
    const before = { sales: balanceOf(business, "sales"), vat: balanceOf(business, "output_vat"), cogs: balanceOf(business, "cost_of_goods_sold") };

    const done = business.returnSale({
      date: "2026-11-21",
      receiptId: receipt.id,
      lines: [{ lineId: receipt.lines[1]!.lineId, quantity: 1_000 }],
      refund: "cash",
    });

    const soapLine = receipt.lines[1]!;
    expect(done).toEqual(expect.objectContaining({ number: 1, total: soapLine.amount }));
    expect(business.findReturn(1)).toEqual(
      expect.objectContaining({ receiptNumber: 1, refund: "cash", total: soapLine.amount, returnedBy: "أيمن", lines: [expect.objectContaining({ itemId: soap, quantity: 1_000 })] }),
    );
    expect(balanceOf(business, "sales") - before.sales).toBe(soapLine.net);
    expect(balanceOf(business, "output_vat") - before.vat).toBe(soapLine.vat);
    expect(balanceOf(business, "cost_of_goods_sold") - before.cogs).toBe(-4_000);
    expect(business.stockOnHand(soap).total).toBe(10_000);
    expect(balanceOf(business, "cash_drawer")).toBe(receipt.total - soapLine.amount);
    expectBooksBalance(business, [rice, soap]);
  });

  test("returning in parts never returns more than was sold, and the last part takes exactly what is left", () => {
    const { business, rice, soap, receipt } = setup();
    const line = receipt.lines[0]!;
    const back = (quantity: number) =>
      business.returnSale({ date: "2026-11-21", receiptId: receipt.id, lines: [{ lineId: line.lineId, quantity }], refund: "cash" });

    const first = back(1_000);
    const second = back(2_000);

    expect(first.total + second.total).toBe(line.amount);
    expect(() => back(1)).toThrow(expect.objectContaining({ code: "return_exceeds_sale" }));
    expect(business.findReceipt(receipt.number).lines[0]!.returned).toBe(3_000);
    expect(balanceOf(business, "sales")).toBe(-receipt.lines[1]!.net);
    expect(business.stockOnHand(rice).total).toBe(30_000);
    expect(business.stockValue(rice)).toBe(90_030);
    expectBooksBalance(business, [rice, soap]);
  });

  test("a refund to the customer's account lowers what they owe", () => {
    const { business, main, rice } = setup();
    const customer = business.addCustomer({ name: "شركة الأمل", phone: "", taxRegistrationNumber: "" });
    const sale = business.postSale({
      date: "2026-11-20",
      warehouseId: main,
      lines: [{ itemId: rice, unit: "base", quantity: 2_000 }],
      customerId: customer,
      payments: [],
    });
    const receipt = business.findReceipt(sale.number);

    business.returnSale({ date: "2026-11-21", receiptId: receipt.id, lines: [{ lineId: receipt.lines[0]!.lineId, quantity: 1_000 }], refund: "account" });

    expect(business.customerBalance(customer)).toBe(3_800);
  });

  test("a refund to an account needs the receipt's customer", () => {
    const { business, receipt } = setup();

    expect(() =>
      business.returnSale({ date: "2026-11-21", receiptId: receipt.id, lines: [{ lineId: receipt.lines[0]!.lineId, quantity: 1_000 }], refund: "account" }),
    ).toThrow(expect.objectContaining({ code: "customer_not_found" }));
  });

  test("a cash refund needs an open shift, and the Z report shows returns and expects less cash", () => {
    const { business, receipt } = setup();
    const shift = business.currentShift()!.id;
    business.returnSale({ date: "2026-11-21", receiptId: receipt.id, lines: [{ lineId: receipt.lines[1]!.lineId, quantity: 1_000 }], refund: "cash" });

    const z = business.zReport(shift);
    expect(z.returns).toBe(receipt.lines[1]!.amount);
    expect(z.expectedCash).toBe(receipt.total - receipt.lines[1]!.amount);

    business.closeShift({ date: "2026-11-21", countedCash: z.expectedCash });
    expect(() =>
      business.returnSale({ date: "2026-11-21", receiptId: receipt.id, lines: [{ lineId: receipt.lines[0]!.lineId, quantity: 1_000 }], refund: "cash" }),
    ).toThrow(expect.objectContaining({ code: "shift_required" }));
  });

  test("a return line must belong to the receipt", () => {
    const { business, receipt } = setup();

    expect(() =>
      business.returnSale({ date: "2026-11-21", receiptId: receipt.id, lines: [{ lineId: 999, quantity: 1_000 }], refund: "cash" }),
    ).toThrow(expect.objectContaining({ code: "return_line_invalid" }));
    expect(() => business.returnSale({ date: "2026-11-21", receiptId: receipt.id, lines: [], refund: "cash" })).toThrow(
      expect.objectContaining({ code: "invoice_needs_lines" }),
    );
  });
});
