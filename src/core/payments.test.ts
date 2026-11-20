import { describe, expect, test } from "vitest";
import { Business } from "./business";

const manager = { name: "أيمن", password: "كلمة سر قوية" };
const shop = { name: "شركة النور", address: "الدقي", taxRegistrationNumber: "", vatRegistered: true, fiscalYearStartMonth: 1 };

function setup() {
  const business = Business.create(":memory:", shop, manager);
  const main = business.warehouses()[0]!.id;
  const standard = business.taxCodes().find((c) => c.kind === "standard")!.id;
  // 1,140.00 incl. VAT = 1,000.00 net.
  const router = business.addItem({ nameAr: "راوتر", baseUnit: "قطعة", barcode: "1", salePrice: 114_000, taxCodeId: standard });
  const supplier = business.addSupplier({ name: "المورد", phone: "", taxRegistrationNumber: "" });
  business.postPurchaseInvoice({
    date: "2026-11-01",
    supplierId: supplier,
    warehouseId: main,
    reference: "",
    lines: [{ itemId: router, unit: "base", quantity: 10_000, unitPrice: 80_000 }],
  });
  business.openShift(0);
  const lines = (pieces: number) => [{ itemId: router, unit: "base" as const, quantity: pieces * 1000 }];
  const sale = { date: "2026-11-20", warehouseId: main };
  return { business, main, router, lines, sale };
}

function balanceOf(business: Business, role: string) {
  const account = business.accounts().find((a) => a.role === role)!;
  const row = business.trialBalance("2026-12-31").rows.find((r) => r.accountId === account.id);
  return row ? row.debit - row.credit : 0;
}

describe("customers", () => {
  test("customers are added from the till with a name and phone, and listed", () => {
    const { business } = setup();
    business.addUser({ name: "سارة", role: "cashier", password: "123456" });

    const id = business.signIn("سارة", "123456").addCustomer({ name: "شركة الأمل", phone: "0100", taxRegistrationNumber: "" });
    business.updateCustomer(id, { taxRegistrationNumber: "123456789" });

    expect(business.customers()).toEqual([
      expect.objectContaining({ id, name: "شركة الأمل", phone: "0100", taxRegistrationNumber: "123456789", active: true }),
    ]);
    expect(business.customerBalance(id)).toBe(0);
    expect(() => business.addCustomer({ name: " ", phone: "", taxRegistrationNumber: "" })).toThrow(
      expect.objectContaining({ code: "customer_name_required" }),
    );
  });
});

describe("paying at the till", () => {
  test("each tender posts to its own account", () => {
    const { business, lines, sale } = setup();

    business.postSale({ ...sale, lines: lines(1), payments: [{ method: "card", amount: 114_000 }] });
    business.postSale({ ...sale, lines: lines(1), payments: [{ method: "wallet", amount: 114_000 }] });
    business.postSale({ ...sale, lines: lines(1), payments: [{ method: "cash", amount: 120_000 }] });

    expect(balanceOf(business, "card_clearing")).toBe(114_000);
    expect(balanceOf(business, "wallet")).toBe(114_000);
    expect(balanceOf(business, "cash_drawer")).toBe(114_000);
    expect(balanceOf(business, "sales")).toBe(-300_000);
  });

  test("a split payment must add up to the total, and change comes only from cash", () => {
    const { business, lines, sale } = setup();

    const done = business.postSale({
      ...sale,
      lines: lines(2),
      payments: [
        { method: "card", amount: 200_000 },
        { method: "cash", amount: 30_000 },
      ],
    });

    expect(done.change).toBe(2_000);
    expect(balanceOf(business, "card_clearing")).toBe(200_000);
    expect(balanceOf(business, "cash_drawer")).toBe(28_000);
    expect(() =>
      business.postSale({ ...sale, lines: lines(1), payments: [{ method: "card", amount: 120_000 }] }),
    ).toThrow(expect.objectContaining({ code: "change_without_cash" }));
    expect(() =>
      business.postSale({ ...sale, lines: lines(1), payments: [{ method: "card", amount: 100_000 }, { method: "cash", amount: 10_000 }] }),
    ).toThrow(expect.objectContaining({ code: "payment_short" }));
  });

  test("the unpaid part of a credit sale goes to the customer's balance", () => {
    const { business, lines, sale } = setup();
    const customer = business.addCustomer({ name: "شركة الأمل", phone: "", taxRegistrationNumber: "" });

    business.postSale({ ...sale, lines: lines(2), customerId: customer, payments: [{ method: "cash", amount: 28_000 }] });
    business.postSale({ ...sale, lines: lines(1), customerId: customer, payments: [] });

    expect(business.customerBalance(customer)).toBe(200_000 + 114_000);
    expect(balanceOf(business, "receivables")).toBe(314_000);
    expect(business.receipts()[1]).toEqual(
      expect.objectContaining({ customerId: customer, payments: [{ method: "cash", amount: 28_000 }], onCredit: 200_000, change: 0 }),
    );
    expect(() => business.postSale({ ...sale, lines: lines(1), payments: [] })).toThrow(expect.objectContaining({ code: "payment_short" }));
  });

  test("a stopped customer cannot buy on credit", () => {
    const { business, lines, sale } = setup();
    const customer = business.addCustomer({ name: "شركة الأمل", phone: "", taxRegistrationNumber: "" });
    business.deactivateCustomer(customer);

    expect(() => business.postSale({ ...sale, lines: lines(1), customerId: customer, payments: [] })).toThrow(
      expect.objectContaining({ code: "customer_inactive" }),
    );
  });

  test("bad tenders are refused", () => {
    const { business, lines, sale } = setup();

    expect(() => business.postSale({ ...sale, lines: lines(1), payments: [{ method: "cash", amount: -1 }] })).toThrow(
      expect.objectContaining({ code: "line_amount_invalid" }),
    );
    expect(() =>
      business.postSale({ ...sale, lines: lines(1), payments: [{ method: "cheque" as "cash", amount: 114_000 }] }),
    ).toThrow(expect.objectContaining({ code: "payment_method_invalid" }));
  });

  test("the Z report shows totals per tender, and expects only the cash", () => {
    const { business, lines, sale } = setup();
    const customer = business.addCustomer({ name: "شركة الأمل", phone: "", taxRegistrationNumber: "" });
    business.postSale({ ...sale, lines: lines(1), payments: [{ method: "cash", amount: 200_000 }] });
    business.postSale({ ...sale, lines: lines(1), payments: [{ method: "card", amount: 114_000 }] });
    business.postSale({ ...sale, lines: lines(1), payments: [{ method: "wallet", amount: 14_000 }, { method: "cash", amount: 100_000 }] });
    business.postSale({ ...sale, lines: lines(1), customerId: customer, payments: [] });

    const z = business.zReport(business.currentShift()!.id);

    expect(z.sales.total).toBe(456_000);
    expect(z.sales.byMethod).toEqual({ cash: 214_000, card: 114_000, wallet: 14_000, credit: 114_000 });
    expect(z.expectedCash).toBe(214_000);
  });
});
