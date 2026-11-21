import type { BusinessSettings } from "../core/business";
import type { Customer } from "../core/customers";
import type { CreditNote, SalesInvoice } from "../core/invoices";
import type { Statement } from "../core/settlements";
import { formatMoney } from "./money";
import { serialNote } from "./serials";
import { formatQuantity } from "./quantity";
import { amountInWords } from "./words";

/** An A4 page: an invoice, a credit note or a statement, already formatted. */
export type A4Document = {
  shop: { name: string; address: string; taxRegistrationNumber: string };
  title: string;
  /** Number, date, reference and the like, shown beside the title. */
  meta: { label: string; value: string }[];
  party: { label: string; name: string; address: string; taxRegistrationNumber: string } | null;
  columns: { label: string; numeric?: boolean }[];
  rows: string[][];
  totals: { label: string; value: string; strong?: boolean }[];
  /** The total in words. */
  words: string;
  notes: string;
};

const shopOf = (s: BusinessSettings): A4Document["shop"] => ({ name: s.name, address: s.address, taxRegistrationNumber: s.taxRegistrationNumber });
const buyer = (c: Customer, label = "العميل"): A4Document["party"] => ({ label, name: c.name, address: c.address, taxRegistrationNumber: c.taxRegistrationNumber });
const rate = (basisPoints: number) => `${basisPoints / 100}%`;
const LINE_COLUMNS: A4Document["columns"] = [
  { label: "م" },
  { label: "الصنف" },
  { label: "الوحدة" },
  { label: "الكمية", numeric: true },
  { label: "سعر الوحدة", numeric: true },
  { label: "الخصم", numeric: true },
  { label: "الصافي", numeric: true },
  { label: "الضريبة", numeric: true },
  { label: "الإجمالي", numeric: true },
];

/** A sales invoice: a tax invoice when the business is VAT-registered. */
export function invoiceA4(invoice: SalesInvoice, settings: BusinessSettings, customer: Customer): A4Document {
  const meta = [
    { label: "رقم الفاتورة", value: String(invoice.number) },
    { label: "التاريخ", value: invoice.date },
  ];
  if (invoice.reference) meta.push({ label: "مرجع العميل", value: invoice.reference });
  const totals: A4Document["totals"] = [];
  if (invoice.discount > 0) {
    totals.push({ label: "الإجمالي قبل الخصم", value: formatMoney(invoice.gross) });
    totals.push({ label: "الخصم", value: formatMoney(invoice.discount) });
  }
  totals.push({ label: "الصافي قبل الضريبة", value: formatMoney(invoice.net) });
  if (settings.vatRegistered) totals.push({ label: "ضريبة القيمة المضافة", value: formatMoney(invoice.vat) });
  totals.push({ label: "الإجمالي المستحق", value: formatMoney(invoice.total), strong: true });
  return {
    shop: shopOf(settings),
    title: settings.vatRegistered ? "فاتورة ضريبية" : "فاتورة مبيعات",
    meta,
    party: buyer(customer),
    columns: LINE_COLUMNS,
    rows: invoice.lines.map((l, i) => [
      String(i + 1),
      l.nameAr + serialNote(l),
      l.unitName,
      formatQuantity(l.quantity),
      formatMoney(l.unitPrice),
      l.discount > 0 ? formatMoney(l.discount) : "",
      formatMoney(l.net),
      settings.vatRegistered ? `${formatMoney(l.vat)} (${rate(l.vatRate)})` : "",
      formatMoney(l.net + l.vat),
    ]),
    totals,
    words: amountInWords(invoice.total),
    notes: invoice.notes,
  };
}

/** A credit note against a sales invoice. */
export function creditNoteA4(note: CreditNote, settings: BusinessSettings, customer: Customer): A4Document {
  const meta = [
    { label: "رقم الإشعار", value: String(note.number) },
    { label: "التاريخ", value: note.date },
    { label: "على فاتورة رقم", value: String(note.invoiceNumber) },
  ];
  const totals: A4Document["totals"] = [{ label: "الصافي قبل الضريبة", value: formatMoney(note.net) }];
  if (settings.vatRegistered) totals.push({ label: "ضريبة القيمة المضافة", value: formatMoney(note.vat) });
  totals.push({ label: "إجمالي الإشعار", value: formatMoney(note.total), strong: true });
  return {
    shop: shopOf(settings),
    title: "إشعار دائن",
    meta,
    party: buyer(customer),
    columns: [LINE_COLUMNS[0]!, LINE_COLUMNS[1]!, LINE_COLUMNS[2]!, LINE_COLUMNS[3]!, LINE_COLUMNS[6]!, LINE_COLUMNS[7]!, LINE_COLUMNS[8]!],
    rows: note.lines.map((l, i) => [
      String(i + 1),
      l.nameAr,
      l.unitName,
      formatQuantity(l.quantity),
      formatMoney(l.net),
      settings.vatRegistered ? formatMoney(l.vat) : "",
      formatMoney(l.net + l.vat),
    ]),
    totals,
    words: amountInWords(note.total),
    notes: note.reason,
  };
}

/** A customer's or supplier's statement of account. */
export function statementA4(
  st: Statement,
  settings: BusinessSettings,
  party: { kind: "customer" | "supplier"; address: string; taxRegistrationNumber: string },
): A4Document {
  const owed = party.kind === "customer" ? "مستحق على العميل" : "مستحق للمورد";
  const balance = (n: number) => (n === 0 ? "0.00" : `${formatMoney(Math.abs(n))} ${n > 0 ? "" : "(دائن)"}`.trim());
  return {
    shop: shopOf(settings),
    title: `${party.kind === "customer" ? "كشف حساب عميل" : "كشف حساب مورد"}${st.currency === "EGP" ? "" : ` (${st.currency})`}`,
    meta: [
      { label: "من", value: st.from },
      { label: "إلى", value: st.to },
    ],
    party: { label: party.kind === "customer" ? "العميل" : "المورد", name: st.name, address: party.address, taxRegistrationNumber: party.taxRegistrationNumber },
    columns: [{ label: "التاريخ" }, { label: "البيان" }, { label: "مدين", numeric: true }, { label: "دائن", numeric: true }, { label: "الرصيد", numeric: true }],
    rows: [
      [st.from, "رصيد أول المدة", "", "", balance(st.opening)],
      ...st.lines.map((l) => [l.date, l.memo, l.debit ? formatMoney(l.debit) : "", l.credit ? formatMoney(l.credit) : "", balance(l.balance)]),
    ],
    totals: [{ label: `الرصيد في ${st.to} (${owed})`, value: balance(st.closing), strong: true }],
    words: st.closing > 0 ? amountInWords(st.closing) : "",
    notes: "",
  };
}

const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

/** The page as HTML for Chromium to print or save as PDF. */
export function a4Html(doc: A4Document, fontCss = ""): string {
  const meta = doc.meta.map((m) => `<div><span class="muted">${escape(m.label)}:</span> <b dir="auto">${escape(m.value)}</b></div>`).join("\n");
  const party = doc.party
    ? `<section class="party"><div class="muted">${escape(doc.party.label)}</div><div class="name">${escape(doc.party.name)}</div>
${doc.party.address ? `<div>${escape(doc.party.address)}</div>` : ""}
${doc.party.taxRegistrationNumber ? `<div>رقم التسجيل الضريبي: <span dir="ltr">${escape(doc.party.taxRegistrationNumber)}</span></div>` : ""}</section>`
    : "";
  const head = doc.columns.map((c) => `<th${c.numeric ? ' class="num"' : ""}>${escape(c.label)}</th>`).join("");
  const rows = doc.rows
    .map((r) => `<tr>${r.map((cell, i) => `<td${doc.columns[i]?.numeric ? ' class="num" dir="ltr"' : ""}>${escape(cell)}</td>`).join("")}</tr>`)
    .join("\n");
  const totals = doc.totals
    .map((t) => `<tr${t.strong ? ' class="strong"' : ""}><th>${escape(t.label)}</th><td class="num" dir="ltr">${escape(t.value)}</td></tr>`)
    .join("\n");
  return `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>
${fontCss}
@page { size: A4; margin: 14mm 12mm; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: "IBM Plex Sans Arabic", Tahoma, "Segoe UI", sans-serif; font-size: 11pt; line-height: 1.5; color: #111; background: #fff; }
header { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; border-bottom: 2px solid #111; padding-bottom: 10px; }
.shop .name { font-size: 16pt; font-weight: 700; }
h1 { font-size: 18pt; font-weight: 700; text-align: left; }
.meta { text-align: left; margin-top: 4px; }
.muted { color: #555; }
.party { margin: 14px 0; padding: 8px 12px; border: 1px solid #bbb; border-radius: 4px; }
.party .name { font-weight: 700; font-size: 12pt; }
table { width: 100%; border-collapse: collapse; }
.lines th, .lines td { border: 1px solid #999; padding: 4px 6px; text-align: right; vertical-align: top; white-space: pre-line; }
.lines th { background: #eee; font-weight: 600; }
.num { text-align: left !important; font-variant-numeric: tabular-nums; white-space: nowrap; }
.lines tr { break-inside: avoid; }
.totals { width: 45%; margin-top: 12px; margin-inline-start: auto; }
.totals th, .totals td { padding: 3px 6px; text-align: right; border-bottom: 1px solid #ddd; }
.totals .strong th, .totals .strong td { font-size: 13pt; font-weight: 700; border-top: 2px solid #111; border-bottom: none; }
.words { margin-top: 12px; font-weight: 600; }
.notes { margin-top: 12px; white-space: pre-line; }
footer { margin-top: 40px; display: flex; justify-content: space-between; color: #555; }
</style></head><body>
<header>
<div class="shop"><div class="name">${escape(doc.shop.name)}</div>
${doc.shop.address ? `<div>${escape(doc.shop.address)}</div>` : ""}
${doc.shop.taxRegistrationNumber ? `<div>رقم التسجيل الضريبي: <span dir="ltr">${escape(doc.shop.taxRegistrationNumber)}</span></div>` : ""}</div>
<div><h1>${escape(doc.title)}</h1><div class="meta">${meta}</div></div>
</header>
${party}
<table class="lines"><thead><tr>${head}</tr></thead><tbody>
${rows}
</tbody></table>
<table class="totals">${totals}</table>
${doc.words ? `<div class="words">${escape(doc.words)}</div>` : ""}
${doc.notes ? `<div class="notes">${escape(doc.notes)}</div>` : ""}
<footer><span>التوقيع: ....................</span><span>الختم</span></footer>
</body></html>`;
}
