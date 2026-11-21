import { describe, expect, test } from "vitest";
import { Business } from "./business";

const manager = { name: "أيمن", password: "كلمة سر قوية" };
const shop = { name: "شركة النور للكمبيوتر", address: "", taxRegistrationNumber: "", vatRegistered: true, fiscalYearStartMonth: 1 };

/**
 * The worked sample month, March 2026: a till sale and a return, an invoice with standard and
 * zero-rated lines and a credit note, a local purchase and a debit note, an import with customs
 * VAT, two expenses with VAT (one voided), and a journal posted straight to input VAT.
 */
function sample() {
  const business = Business.create(":memory:", shop, manager);
  const main = business.warehouses()[0]!.id;
  const code = (kind: string) => business.taxCodes().find((c) => c.kind === kind)!.id;
  const account = (role: string) => business.accounts().find((a) => a.role === role)!.id;
  const router = business.addItem({ nameAr: "راوتر", baseUnit: "قطعة", salePrice: 114_000, taxCodeId: code("standard") });
  const book = business.addItem({ nameAr: "كتاب للتصدير", baseUnit: "قطعة", salePrice: 5_000, taxCodeId: code("zero_rated") });
  const bread = business.addItem({ nameAr: "خبز", baseUnit: "رغيف", salePrice: 2_000, taxCodeId: code("exempt") });
  const supplier = business.addSupplier({ name: "مورد محلي", phone: "", taxRegistrationNumber: "" });
  const foreign = business.addSupplier({ name: "Shenzhen Networks", phone: "", taxRegistrationNumber: "", currency: "USD" });
  const customs = business.addSupplier({ name: "مصلحة الجمارك", phone: "", taxRegistrationNumber: "" });
  const customer = business.addCustomer({ name: "شركة الأمل", phone: "", taxRegistrationNumber: "" });

  const purchase = business.postPurchaseInvoice({
    date: "2026-03-01",
    supplierId: supplier,
    warehouseId: main,
    reference: "P-100",
    lines: [
      { itemId: router, unit: "base", quantity: 10_000, unitPrice: 60_000 },
      { itemId: bread, unit: "base", quantity: 20_000, unitPrice: 1_000 },
      { itemId: book, unit: "base", quantity: 10_000, unitPrice: 3_000 },
    ],
  });
  business.openShift(0);
  const sale = business.postSale({
    date: "2026-03-02",
    warehouseId: main,
    lines: [
      { itemId: router, unit: "base", quantity: 2_000 },
      { itemId: bread, unit: "base", quantity: 1_000 },
    ],
    payments: [{ method: "cash", amount: 230_000 }],
  });
  const receipt = business.findReceipt(sale.number);
  business.returnSale({ date: "2026-03-03", receiptId: receipt.id, lines: [{ lineId: receipt.lines[0]!.lineId, quantity: 1_000 }], refund: "cash" });
  const invoice = business.postSalesInvoice({
    date: "2026-03-04",
    customerId: customer,
    warehouseId: main,
    reference: "",
    notes: "",
    lines: [
      { itemId: router, unit: "base", quantity: 3_000, unitPrice: 100_000 },
      { itemId: book, unit: "base", quantity: 4_000, unitPrice: 4_000 },
    ],
  });
  const invoiceLine = business.findSalesInvoice(invoice.number).lines[0]!.lineId;
  business.postCreditNote({ date: "2026-03-05", invoiceId: invoice.id, reason: "مرتجع", lines: [{ lineId: invoiceLine, quantity: 1_000 }] });
  const purchaseLine = business.purchaseInvoices().find((p) => p.id === purchase)!.lines[0]!.lineId;
  business.postDebitNote({ date: "2026-03-06", purchaseInvoiceId: purchase, reason: "تالف", lines: [{ lineId: purchaseLine, quantity: 1_000 }] });
  const imported = business.postPurchaseInvoice({
    date: "2026-03-07",
    supplierId: foreign,
    warehouseId: main,
    reference: "SZ-7",
    rate: 50_000_000,
    lines: [{ itemId: router, unit: "base", quantity: 5_000, unitPrice: 10_000 }],
  });
  business.postImportShipment({
    date: "2026-03-07",
    reference: "BL-1",
    purchaseInvoiceIds: [imported],
    spreadBy: "value",
    costs: [{ kind: "customs_duty", payeeId: customs, amount: 30_000, vat: 70_000 }],
  });
  const utilities = business.accounts().find((a) => a.type === "expense" && a.name !== "الإيجار" && !a.role)!.id;
  const rent = business.accounts().find((a) => a.name === "الإيجار")!.id;
  business.recordExpense({
    date: "2026-03-08",
    expenseAccountId: utilities,
    amount: 10_000,
    vat: 1_400,
    paidFrom: { accountId: account("main_cash") },
    memo: "",
  });
  const voided = business.recordExpense({
    date: "2026-03-09",
    expenseAccountId: utilities,
    amount: 5_000,
    vat: 700,
    paidFrom: { supplierId: supplier },
    memo: "",
  });
  business.voidEntry(voided.entryId, "2026-03-10");
  business.recordExpense({
    date: "2026-03-11",
    expenseAccountId: rent,
    amount: 50_000,
    vat: 0,
    paidFrom: { accountId: account("main_cash") },
    memo: "",
  });
  business.postJournalEntry({
    date: "2026-03-15",
    memo: "تسوية ضريبة مدخلات",
    lines: [
      { accountId: account("input_vat"), debit: 500 },
      { accountId: account("main_cash"), credit: 500 },
    ],
  });
  // April: outside the return.
  business.postSalesInvoice({
    date: "2026-04-01",
    customerId: customer,
    warehouseId: main,
    reference: "",
    notes: "",
    lines: [{ itemId: router, unit: "base", quantity: 1_000, unitPrice: 100_000 }],
  });
  return { business, account };
}

describe("VAT return", () => {
  test("the worked sample month matches to the piastre, by section and tax kind", async () => {
    const { business } = sample();
    const r = business.vatReturn("2026-03-01", "2026-03-31");
    expect(r.boxes.map((b) => [b.section, b.taxKind, b.net, b.vat])).toEqual([
      // Till 200,000 − return 100,000 + invoice 300,000 − credit note 100,000.
      ["sales", "standard", 300_000, 42_000],
      ["sales", "zero_rated", 16_000, 0],
      ["sales", "exempt", 2_000, 0],
      // 600,000 less one router sent back; the USD invoice is an import and stays out.
      ["purchases", "standard", 540_000, 75_600],
      ["purchases", "zero_rated", 30_000, 0],
      ["purchases", "exempt", 20_000, 0],
      // The voided expense cancels itself; rent carries no VAT.
      ["expenses", "standard", 10_000, 1_400],
      ["imports", "standard", 30_000, 70_000],
    ]);
    expect([r.outputVat, r.inputVat, r.outputAdjustments, r.inputAdjustments, r.netDue]).toEqual([42_000, 147_000, 0, 500, -105_500]);
    await expect(`${JSON.stringify(r, null, 2)}\n`).toMatchFileSnapshot("__golden__/reports/vat-return.json");
  });

  test("every figure drills down to the documents behind it", () => {
    const { business } = sample();
    const r = business.vatReturn("2026-03-01", "2026-03-31");
    const behind = (section: string, taxKind: string) =>
      r.transactions.filter((t) => t.section === section && t.taxKind === taxKind).map((t) => [t.kind, t.number, t.date, t.party, t.net, t.vat]);
    expect(behind("sales", "standard")).toEqual([
      ["sale", "1", "2026-03-02", "", 200_000, 28_000],
      ["sale_return", "1", "2026-03-03", "", -100_000, -14_000],
      ["sales_invoice", "1", "2026-03-04", "شركة الأمل", 300_000, 42_000],
      ["credit_note", "1", "2026-03-05", "شركة الأمل", -100_000, -14_000],
    ]);
    expect(behind("expenses", "standard")).toEqual([
      ["expense", "1", "2026-03-08", "", 10_000, 1_400],
      ["expense", "2", "2026-03-09", "مورد محلي", 5_000, 700],
      ["expense_void", "2", "2026-03-10", "مورد محلي", -5_000, -700],
    ]);
    const entry = business.journalEntry(r.transactions.find((t) => t.kind === "debit_note")!.entryId);
    expect(entry.kind).toBe("debit_note");
  });

  test("the ledger agrees: VAT accounts moved by the return's figures", () => {
    const { business, account } = sample();
    const r = business.vatReturn("2026-03-01", "2026-03-31");
    const moved = (role: string) => {
      const ledger = business.generalLedger(account(role), "2026-03-01", "2026-03-31");
      return ledger.closing - ledger.opening;
    };
    expect(-moved("output_vat")).toBe(r.outputVat + r.outputAdjustments);
    expect(moved("input_vat")).toBe(r.inputVat + r.inputAdjustments);
  });

  test("a business not registered for VAT has no return", () => {
    const business = Business.create(":memory:", { ...shop, vatRegistered: false }, manager);
    expect(() => business.vatReturn("2026-03-01", "2026-03-31")).toThrow(expect.objectContaining({ code: "not_vat_registered" }));
  });
});
