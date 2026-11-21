import { describe, expect, test } from "vitest";
import { Business } from "./business";

const manager = { name: "أيمن", password: "كلمة سر قوية" };
const shop = { name: "شركة النور للكمبيوتر", address: "", taxRegistrationNumber: "", vatRegistered: true, fiscalYearStartMonth: 1 };

function setup() {
  const business = Business.create(":memory:", shop, manager);
  const main = business.warehouses()[0]!.id;
  const standard = business.taxCodes().find((c) => c.kind === "standard")!.id;
  // 1,140.00 each with VAT.
  const router = business.addItem({ nameAr: "راوتر", baseUnit: "قطعة", salePrice: 114_000, taxCodeId: standard });
  const supplier = business.addSupplier({ name: "مورد", phone: "", taxRegistrationNumber: "" });
  business.postPurchaseInvoice({
    date: "2026-01-01",
    supplierId: supplier,
    warehouseId: main,
    reference: "",
    lines: [{ itemId: router, unit: "base", quantity: 50_000, unitPrice: 60_000 }],
  });
  // A limit of 3,000.00: two routers (2,280.00) fit, three (3,420.00) are 420.00 over.
  const amal = business.addCustomer({ name: "شركة الأمل", phone: "", taxRegistrationNumber: "", creditLimit: 300_000 });
  const open = business.addCustomer({ name: "مكتب النور", phone: "", taxRegistrationNumber: "" });
  business.addUser({ name: "سارة", role: "cashier", password: "123456" });
  business.addUser({ name: "محاسب", role: "accountant", password: "123456" });
  const invoice = (routers: number, customerId = amal) => ({
    date: "2026-02-01",
    customerId,
    warehouseId: main,
    reference: "",
    notes: "",
    lines: [{ itemId: router, unit: "base" as const, quantity: routers * 1_000, unitPrice: 100_000 }],
  });
  const sale = (routers: number, paid: number) => ({
    date: "2026-02-01",
    warehouseId: main,
    customerId: amal,
    lines: [{ itemId: router, unit: "base" as const, quantity: routers * 1_000 }],
    payments: paid > 0 ? [{ method: "cash" as const, amount: paid }] : [],
  });
  return { business, amal, open, invoice, sale };
}

describe("credit limit", () => {
  test("an invoice that takes the balance past the limit is refused with the amount over", () => {
    const s = setup();
    s.business.postSalesInvoice(s.invoice(2));
    expect(() => s.business.postSalesInvoice(s.invoice(1))).toThrow(expect.objectContaining({ code: "credit_limit_exceeded", amount: 42_000 }));
    expect(s.business.customerBalance(s.amal)).toBe(228_000);
    // No limit, no check.
    s.business.postSalesInvoice(s.invoice(10, s.open));
  });

  test("a manager's sign-in on the document lets it through, and the approval is in the audit log without the password", () => {
    const s = setup();
    const cashier = s.business.signIn("محاسب", "123456");
    cashier.postSalesInvoice({ ...s.invoice(3), creditApproval: manager });

    expect(s.business.customerBalance(s.amal)).toBe(342_000);
    const log = s.business.auditLog();
    const approval = log.find((e) => e.action === "approveCreditLimit")!;
    expect(approval).toEqual(expect.objectContaining({ userName: "أيمن", entityId: s.amal }));
    expect(JSON.parse(approval.detail)).toEqual(expect.objectContaining({ over: 42_000, document: "postSalesInvoice", requestedBy: "محاسب" }));
    expect(log.map((e) => e.detail).join("")).not.toContain(manager.password);
  });

  test("only a manager can approve, with the right password", () => {
    const s = setup();
    expect(() => s.business.postSalesInvoice({ ...s.invoice(3), creditApproval: { name: "محاسب", password: "123456" } })).toThrow(
      expect.objectContaining({ code: "approval_not_manager" }),
    );
    expect(() => s.business.postSalesInvoice({ ...s.invoice(3), creditApproval: { name: manager.name, password: "خطأ" } })).toThrow(
      expect.objectContaining({ code: "sign_in_failed" }),
    );
    expect(s.business.customerBalance(s.amal)).toBe(0);
  });

  test("at the till only the part left on credit counts", () => {
    const s = setup();
    const till = s.business.signIn("سارة", "123456");
    till.openShift(0);
    // Three routers, 1,000.00 paid: 2,420.00 on credit fits.
    till.postSale(s.sale(3, 100_000));
    expect(() => till.postSale(s.sale(1, 0))).toThrow(expect.objectContaining({ code: "credit_limit_exceeded", amount: 56_000 }));
    till.postSale({ ...s.sale(1, 0), creditApproval: manager });
    expect(s.business.customerBalance(s.amal)).toBe(356_000);
  });
});
