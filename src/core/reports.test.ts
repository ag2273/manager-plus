import { describe, expect, test } from "vitest";
import { Business } from "./business";

const manager = { name: "أيمن", password: "كلمة سر قوية" };
const shop = { name: "شركة النور للكمبيوتر", address: "", taxRegistrationNumber: "", vatRegistered: true, fiscalYearStartMonth: 1 };

/** A fixed sample business for March 2026: a purchase, a till sale, an invoice with a credit note, and rent. */
function sample() {
  const business = Business.create(":memory:", shop, manager);
  const main = business.warehouses()[0]!.id;
  const account = (role: string) => business.accounts().find((a) => a.role === role)!.id;
  const standard = business.taxCodes().find((c) => c.kind === "standard")!.id;
  const router = business.addItem({ nameAr: "راوتر", baseUnit: "قطعة", salePrice: 114_000, taxCodeId: standard });
  const supplier = business.addSupplier({ name: "مورد", phone: "", taxRegistrationNumber: "" });
  const customer = business.addCustomer({ name: "شركة الأمل", phone: "", taxRegistrationNumber: "" });
  business.postJournalEntry({ date: "2026-03-01", memo: "رأس المال", lines: [{ accountId: account("main_cash"), debit: 1_000_000 }, { accountId: account("capital"), credit: 1_000_000 }] });
  business.postPurchaseInvoice({ date: "2026-03-01", supplierId: supplier, warehouseId: main, reference: "", lines: [{ itemId: router, unit: "base", quantity: 10_000, unitPrice: 60_000 }] });
  business.openShift(0);
  business.postSale({ date: "2026-03-02", warehouseId: main, lines: [{ itemId: router, unit: "base", quantity: 2_000 }], payments: [{ method: "cash", amount: 230_000 }] });
  const invoice = business.postSalesInvoice({
    date: "2026-03-03",
    customerId: customer,
    warehouseId: main,
    reference: "",
    notes: "",
    lines: [{ itemId: router, unit: "base", quantity: 3_000, unitPrice: 100_000 }],
  });
  const lineId = business.findSalesInvoice(invoice.number).lines[0]!.lineId;
  business.postCreditNote({ date: "2026-03-04", invoiceId: invoice.id, reason: "مرتجع", lines: [{ lineId, quantity: 1_000 }] });
  const rent = business.accounts().find((a) => a.name === "الإيجار")!.id;
  business.recordExpense({ date: "2026-03-05", expenseAccountId: rent, amount: 50_000, vat: 0, paidFrom: { accountId: account("main_cash") }, memo: "" });
  return { business, router, rent, account };
}

const golden = (name: string, value: unknown) => expect(`${JSON.stringify(value, null, 2)}\n`).toMatchFileSnapshot(`__golden__/reports/${name}.json`);

describe("reports on the sample business", () => {
  test("profit and loss: sales after the credit note, cost of sales and rent", async () => {
    const { business } = sample();
    const pnl = business.profitAndLoss("2026-03-01", "2026-03-31");
    expect([pnl.totalIncome, pnl.totalExpenses, pnl.netProfit]).toEqual([400_000, 290_000, 110_000]);
    await golden("profit-and-loss", pnl);
  });

  test("balance sheet balances, with the period's profit under equity", async () => {
    const { business } = sample();
    const bs = business.balanceSheet("2026-03-31");
    expect(bs.profit).toBe(110_000);
    expect(bs.totalAssets).toBe(bs.totalLiabilitiesAndEquity);
    await golden("balance-sheet", bs);
  });

  test("general ledger with the balance brought forward, drilling down to each entry", async () => {
    const { business, account } = sample();
    const cash = business.generalLedger(account("main_cash"), "2026-03-02", "2026-03-31");
    expect([cash.opening, cash.closing]).toEqual([1_000_000, 950_000]);
    const entry = business.journalEntry(cash.lines[0]!.entryId);
    expect(entry).toEqual(expect.objectContaining({ kind: "expense", voided: false }));
    expect(entry.lines.map((l) => [l.name, l.debit, l.credit])).toEqual([
      ["الإيجار", 50_000, 0],
      ["الخزينة الرئيسية", 0, 50_000],
    ]);
    await golden("general-ledger", cash);
  });

  test("sales by item, by day and by payment method", async () => {
    const { business } = sample();
    const byItem = business.salesByItem("2026-03-01", "2026-03-31");
    expect(byItem.map((r) => [r.nameAr, r.quantity, r.net, r.cost, r.grossProfit])).toEqual([["راوتر", 4_000, 400_000, 240_000, 160_000]]);
    const byDay = business.salesByDay("2026-03-01", "2026-03-31");
    expect(byDay.map((r) => [r.date, r.total])).toEqual([
      ["2026-03-02", 228_000],
      ["2026-03-03", 342_000],
      ["2026-03-04", -114_000],
    ]);
    expect(business.salesByPaymentMethod("2026-03-01", "2026-03-31")).toEqual([
      { method: "cash", total: 228_000 },
      { method: "card", total: 0 },
      { method: "wallet", total: 0 },
      { method: "credit", total: 228_000 },
    ]);
    expect(business.salesDocuments("2026-03-03", "2026-03-03").map((d) => [d.kind, d.number, d.total])).toEqual([["sales_invoice", 1, 342_000]]);
    await golden("sales-by-item", byItem);
    await golden("sales-by-day", byDay);
  });

  test("stock quantity and value at any date", async () => {
    const { business } = sample();
    expect(business.stockAt("2026-03-02").rows.map((r) => [r.quantity, r.value])).toEqual([[8_000, 480_000]]);
    const end = business.stockAt("2026-03-31");
    expect(end.totalValue).toBe(360_000);
    expect(business.stockAt("2026-02-28").rows).toEqual([]);
    await golden("stock", end);
  });

  test("the dashboard shows the day's sales, profit, the cash expected in the drawer and low stock", () => {
    const { business, router } = sample();
    business.setItemMinimum(router, 10_000);
    expect(business.dashboard("2026-03-02")).toEqual({ date: "2026-03-02", sales: 228_000, grossProfit: 80_000, cashExpected: 228_000, lowStock: 1 });
  });
});
