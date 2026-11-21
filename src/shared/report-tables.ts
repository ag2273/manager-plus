import type { BusinessSettings } from "../core/business";
import type { BalanceSheet, DaySalesRow, GeneralLedger, ItemSalesRow, MethodSalesRow, ProfitAndLoss, ReportRow, StockReport } from "../core/reports";
import type { A4Document } from "./a4";
import { formatMoney } from "./money";
import { formatQuantity } from "./quantity";
import type { Sheet, SheetCell } from "./xlsx";

export type Lang = "ar" | "en";
/** A report laid out for export: raw piastres and thousandths, formatted only when printed. */
export type ReportTable = {
  lang: Lang;
  title: string;
  /** The period or date. */
  meta: { label: string; value: string }[];
  columns: { label: string; kind: "text" | "money" | "quantity" }[];
  rows: SheetCell[][];
  totals: { label: string; value: number }[];
};

const L = {
  ar: {
    from: "من",
    to: "إلى",
    asOf: "في",
    code: "الكود",
    account: "الحساب",
    amount: "المبلغ",
    pnl: "قائمة الدخل (الأرباح والخسائر)",
    income: "الإيرادات",
    expenses: "المصروفات",
    totalIncome: "إجمالي الإيرادات",
    totalExpenses: "إجمالي المصروفات",
    netProfit: "صافي الربح",
    bs: "الميزانية العمومية",
    assets: "الأصول",
    liabilities: "الخصوم",
    equity: "حقوق الملكية",
    profit: "أرباح الفترة",
    totalAssets: "إجمالي الأصول",
    totalLE: "إجمالي الخصوم وحقوق الملكية",
    gl: "دفتر الأستاذ",
    date: "التاريخ",
    memo: "البيان",
    debit: "مدين",
    credit: "دائن",
    balance: "الرصيد",
    opening: "رصيد أول المدة",
    closing: "رصيد آخر المدة",
    byItem: "المبيعات حسب الصنف",
    item: "الصنف",
    quantity: "الكمية",
    net: "صافي المبيعات",
    cost: "التكلفة",
    grossProfit: "مجمل الربح",
    byDay: "المبيعات اليومية",
    documents: "عدد المستندات",
    vat: "الضريبة",
    total: "الإجمالي",
    byMethod: "المبيعات حسب طريقة الدفع",
    method: "طريقة الدفع",
    methods: { cash: "نقدي", card: "بطاقة", wallet: "محفظة / إنستاباي", credit: "آجل" },
    stock: "قيمة المخزون",
    value: "القيمة",
    totalValue: "إجمالي قيمة المخزون",
  },
  en: {
    from: "From",
    to: "To",
    asOf: "As of",
    code: "Code",
    account: "Account",
    amount: "Amount",
    pnl: "Profit and loss",
    income: "Income",
    expenses: "Expenses",
    totalIncome: "Total income",
    totalExpenses: "Total expenses",
    netProfit: "Net profit",
    bs: "Balance sheet",
    assets: "Assets",
    liabilities: "Liabilities",
    equity: "Equity",
    profit: "Profit for the period",
    totalAssets: "Total assets",
    totalLE: "Total liabilities and equity",
    gl: "General ledger",
    date: "Date",
    memo: "Description",
    debit: "Debit",
    credit: "Credit",
    balance: "Balance",
    opening: "Opening balance",
    closing: "Closing balance",
    byItem: "Sales by item",
    item: "Item",
    quantity: "Quantity",
    net: "Net sales",
    cost: "Cost",
    grossProfit: "Gross profit",
    byDay: "Sales by day",
    documents: "Documents",
    vat: "VAT",
    total: "Total",
    byMethod: "Sales by payment method",
    method: "Method",
    methods: { cash: "Cash", card: "Card", wallet: "Wallet / InstaPay", credit: "On account" },
    stock: "Stock value",
    value: "Value",
    totalValue: "Total stock value",
  },
} as const;

const period = (l: (typeof L)[Lang], from: string, to: string) => [
  { label: l.from, value: from },
  { label: l.to, value: to },
];
const accountRows = (heading: string, rows: ReportRow[]): SheetCell[][] => [[null, heading, null], ...rows.map((r) => [r.code, r.name, r.amount])];

export function pnlTable(r: ProfitAndLoss, lang: Lang): ReportTable {
  const l = L[lang];
  return {
    lang,
    title: l.pnl,
    meta: period(l, r.from, r.to),
    columns: [{ label: l.code, kind: "text" }, { label: l.account, kind: "text" }, { label: l.amount, kind: "money" }],
    rows: [...accountRows(l.income, r.income), ...accountRows(l.expenses, r.expenses)],
    totals: [
      { label: l.totalIncome, value: r.totalIncome },
      { label: l.totalExpenses, value: r.totalExpenses },
      { label: l.netProfit, value: r.netProfit },
    ],
  };
}

export function balanceSheetTable(r: BalanceSheet, lang: Lang): ReportTable {
  const l = L[lang];
  return {
    lang,
    title: l.bs,
    meta: [{ label: l.asOf, value: r.asOf }],
    columns: [{ label: l.code, kind: "text" }, { label: l.account, kind: "text" }, { label: l.amount, kind: "money" }],
    rows: [...accountRows(l.assets, r.assets), ...accountRows(l.liabilities, r.liabilities), ...accountRows(l.equity, r.equity), [null, l.profit, r.profit]],
    totals: [
      { label: l.totalAssets, value: r.totalAssets },
      { label: l.totalLE, value: r.totalLiabilitiesAndEquity },
    ],
  };
}

export function ledgerTable(r: GeneralLedger, lang: Lang): ReportTable {
  const l = L[lang];
  return {
    lang,
    title: `${l.gl}: ${r.code} ${r.name}`,
    meta: period(l, r.from, r.to),
    columns: [
      { label: l.date, kind: "text" },
      { label: l.memo, kind: "text" },
      { label: l.debit, kind: "money" },
      { label: l.credit, kind: "money" },
      { label: l.balance, kind: "money" },
    ],
    rows: [[r.from, l.opening, null, null, r.opening], ...r.lines.map((x) => [x.date, x.memo, x.debit || null, x.credit || null, x.balance])],
    totals: [{ label: l.closing, value: r.closing }],
  };
}

export function salesByItemTable(rows: ItemSalesRow[], from: string, to: string, lang: Lang): ReportTable {
  const l = L[lang];
  return {
    lang,
    title: l.byItem,
    meta: period(l, from, to),
    columns: [
      { label: l.item, kind: "text" },
      { label: l.quantity, kind: "quantity" },
      { label: l.net, kind: "money" },
      { label: l.cost, kind: "money" },
      { label: l.grossProfit, kind: "money" },
    ],
    rows: rows.map((r) => [r.nameAr, r.quantity, r.net, r.cost, r.grossProfit]),
    totals: [
      { label: l.net, value: rows.reduce((t, r) => t + r.net, 0) },
      { label: l.grossProfit, value: rows.reduce((t, r) => t + r.grossProfit, 0) },
    ],
  };
}

export function salesByDayTable(rows: DaySalesRow[], from: string, to: string, lang: Lang): ReportTable {
  const l = L[lang];
  return {
    lang,
    title: l.byDay,
    meta: period(l, from, to),
    columns: [
      { label: l.date, kind: "text" },
      { label: l.documents, kind: "text" },
      { label: l.net, kind: "money" },
      { label: l.vat, kind: "money" },
      { label: l.total, kind: "money" },
    ],
    rows: rows.map((r) => [r.date, String(r.documents), r.net, r.vat, r.total]),
    totals: [{ label: l.total, value: rows.reduce((t, r) => t + r.total, 0) }],
  };
}

export function salesByMethodTable(rows: MethodSalesRow[], from: string, to: string, lang: Lang): ReportTable {
  const l = L[lang];
  return {
    lang,
    title: l.byMethod,
    meta: period(l, from, to),
    columns: [{ label: l.method, kind: "text" }, { label: l.total, kind: "money" }],
    rows: rows.map((r) => [l.methods[r.method], r.total]),
    totals: [{ label: l.total, value: rows.reduce((t, r) => t + r.total, 0) }],
  };
}

export function stockTable(r: StockReport, lang: Lang): ReportTable {
  const l = L[lang];
  return {
    lang,
    title: l.stock,
    meta: [{ label: l.asOf, value: r.asOf }],
    columns: [{ label: l.item, kind: "text" }, { label: l.quantity, kind: "quantity" }, { label: l.value, kind: "money" }],
    rows: r.rows.map((x) => [x.nameAr, x.quantity, x.value]),
    totals: [{ label: l.totalValue, value: r.totalValue }],
  };
}

const show = (value: SheetCell, kind: "text" | "money" | "quantity") =>
  value === null ? "" : typeof value === "number" ? (kind === "money" ? formatMoney(value) : kind === "quantity" ? formatQuantity(value) : String(value)) : value;

/** The report as an A4 page for print or PDF. */
export function reportA4(t: ReportTable, settings: BusinessSettings): A4Document {
  return {
    lang: t.lang,
    shop: { name: settings.name, address: settings.address, taxRegistrationNumber: settings.taxRegistrationNumber },
    title: t.title,
    meta: t.meta,
    party: null,
    columns: t.columns.map((c) => ({ label: c.label, numeric: c.kind !== "text" })),
    rows: t.rows.map((r) => r.map((v, i) => show(v, t.columns[i]?.kind ?? "text"))),
    totals: t.totals.map((x, i) => ({ label: x.label, value: formatMoney(x.value), strong: i === t.totals.length - 1 })),
    words: "",
    notes: "",
  };
}

/** The report as an Excel sheet: the rows, a blank line, then the totals. */
export function reportSheet(t: ReportTable): Sheet {
  // Totals go under the last column, which is a money column in every report.
  const last = t.columns.length - 1;
  const totals = t.totals.map((x) => t.columns.map((_, i) => (i === 0 ? x.label : i === last ? x.value : null)));
  return { name: t.title, rightToLeft: t.lang === "ar", columns: t.columns, rows: [...t.rows, [], ...totals] };
}
