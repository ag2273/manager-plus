import type { BusinessSettings } from "./books/business";
import type { Customer } from "./books/customers";
import type { CreditNote, SalesInvoice } from "./books/invoices";
import type { Quotation } from "./books/quotations";
import type { Statement } from "./books/settlements";
import { formatMoney } from "./money";
import { lineName, type DocLang } from "./receipt";
import { serialNote } from "./serials";
import { formatQuantity } from "./quantity";
import { amountInWords } from "./words";

/** An A4 page: an invoice, a credit note or a statement, already formatted. */
export type A4Document = {
  /** Arabic (right to left) unless set to English. */
  lang?: DocLang;
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

/** The words printed on A4 documents, in each document language. */
const TEXT = {
  ar: {
    columns: ["م", "الصنف", "الوحدة", "الكمية", "سعر الوحدة", "الخصم", "الصافي", "الضريبة", "الإجمالي"],
    customer: "العميل",
    supplier: "المورد",
    addressee: "السادة",
    receiver: "المستلم",
    invoiceNumber: "رقم الفاتورة",
    date: "التاريخ",
    customerReference: "مرجع العميل",
    grossBeforeDiscount: "الإجمالي قبل الخصم",
    discount: "الخصم",
    netBeforeVat: "الصافي قبل الضريبة",
    vat: "ضريبة القيمة المضافة",
    totalDue: "الإجمالي المستحق",
    total: "الإجمالي",
    taxInvoice: "فاتورة ضريبية",
    salesInvoice: "فاتورة مبيعات",
    noteNumber: "رقم الإشعار",
    onInvoice: "على فاتورة رقم",
    noteTotal: "إجمالي الإشعار",
    creditNote: "إشعار دائن",
    quotationNumber: "رقم العرض",
    validUntil: "ساري حتى",
    quotation: "عرض سعر",
    deliveryNote: "إذن تسليم",
    received: "استلمت البضاعة الموضحة أعلاه بحالة جيدة.\nاسم المستلم: ....................   التاريخ: ...........",
    owedByCustomer: "مستحق على العميل",
    owedToSupplier: "مستحق للمورد",
    creditSide: "(دائن)",
    customerStatement: "كشف حساب عميل",
    supplierStatement: "كشف حساب مورد",
    from: "من",
    to: "إلى",
    statementColumns: ["التاريخ", "البيان", "مدين", "دائن", "الرصيد"],
    opening: "رصيد أول المدة",
    balanceOn: (date: string, owed: string) => `الرصيد في ${date} (${owed})`,
    taxNumber: "رقم التسجيل الضريبي",
    signature: "التوقيع",
    stamp: "الختم",
  },
  en: {
    columns: ["#", "Item", "Unit", "Qty", "Unit price", "Discount", "Net", "VAT", "Total"],
    customer: "Customer",
    supplier: "Supplier",
    addressee: "To",
    receiver: "Delivered to",
    invoiceNumber: "Invoice no.",
    date: "Date",
    customerReference: "Customer reference",
    grossBeforeDiscount: "Total before discount",
    discount: "Discount",
    netBeforeVat: "Net before VAT",
    vat: "VAT",
    totalDue: "Total due",
    total: "Total",
    taxInvoice: "Tax invoice",
    salesInvoice: "Sales invoice",
    noteNumber: "Credit note no.",
    onInvoice: "Against invoice no.",
    noteTotal: "Credit note total",
    creditNote: "Credit note",
    quotationNumber: "Quotation no.",
    validUntil: "Valid until",
    quotation: "Quotation",
    deliveryNote: "Delivery note",
    received: "Received the goods above in good condition.\nReceived by: ....................   Date: ...........",
    owedByCustomer: "owed by the customer",
    owedToSupplier: "owed to the supplier",
    creditSide: "(credit)",
    customerStatement: "Customer statement",
    supplierStatement: "Supplier statement",
    from: "From",
    to: "To",
    statementColumns: ["Date", "Description", "Debit", "Credit", "Balance"],
    opening: "Opening balance",
    balanceOn: (date: string, owed: string) => `Balance on ${date} (${owed})`,
    taxNumber: "Tax registration no.",
    signature: "Signature",
    stamp: "Stamp",
  },
};

const shopOf = (s: BusinessSettings): A4Document["shop"] => ({ name: s.name, address: s.address, taxRegistrationNumber: s.taxRegistrationNumber });
const buyer = (c: Customer, label: string): A4Document["party"] => ({ label, name: c.name, address: c.address, taxRegistrationNumber: c.taxRegistrationNumber });
const rate = (basisPoints: number) => `${basisPoints / 100}%`;
/** Invoice columns: #, item, unit, quantity, unit price, discount, net, VAT, total. Numbers from quantity on. */
const lineColumns = (lang: DocLang, pick = [0, 1, 2, 3, 4, 5, 6, 7, 8]): A4Document["columns"] =>
  pick.map((i) => ({ label: TEXT[lang].columns[i]!, ...(i >= 3 ? { numeric: true } : {}) }));

/** A sales invoice: a tax invoice when the business is VAT-registered. */
export function invoiceA4(invoice: SalesInvoice, settings: BusinessSettings, customer: Customer, lang: DocLang = "ar"): A4Document {
  const t = TEXT[lang];
  const meta = [
    { label: t.invoiceNumber, value: String(invoice.number) },
    { label: t.date, value: invoice.date },
  ];
  if (invoice.reference) meta.push({ label: t.customerReference, value: invoice.reference });
  const totals: A4Document["totals"] = [];
  if (invoice.discount > 0) {
    totals.push({ label: t.grossBeforeDiscount, value: formatMoney(invoice.gross) });
    totals.push({ label: t.discount, value: formatMoney(invoice.discount) });
  }
  totals.push({ label: t.netBeforeVat, value: formatMoney(invoice.net) });
  if (settings.vatRegistered) totals.push({ label: t.vat, value: formatMoney(invoice.vat) });
  totals.push({ label: t.totalDue, value: formatMoney(invoice.total), strong: true });
  return {
    lang,
    shop: shopOf(settings),
    title: settings.vatRegistered ? t.taxInvoice : t.salesInvoice,
    meta,
    party: buyer(customer, t.customer),
    columns: lineColumns(lang),
    rows: invoice.lines.map((l, i) => [
      String(i + 1),
      lineName(l, lang) + serialNote(l, lang),
      l.unitName,
      formatQuantity(l.quantity),
      formatMoney(l.unitPrice),
      l.discount > 0 ? formatMoney(l.discount) : "",
      formatMoney(l.net),
      settings.vatRegistered ? `${formatMoney(l.vat)} (${rate(l.vatRate)})` : "",
      formatMoney(l.net + l.vat),
    ]),
    totals,
    words: amountInWords(invoice.total, lang),
    notes: invoice.notes,
  };
}

/** A credit note against a sales invoice. */
export function creditNoteA4(note: CreditNote, settings: BusinessSettings, customer: Customer, lang: DocLang = "ar"): A4Document {
  const t = TEXT[lang];
  const meta = [
    { label: t.noteNumber, value: String(note.number) },
    { label: t.date, value: note.date },
    { label: t.onInvoice, value: String(note.invoiceNumber) },
  ];
  const totals: A4Document["totals"] = [{ label: t.netBeforeVat, value: formatMoney(note.net) }];
  if (settings.vatRegistered) totals.push({ label: t.vat, value: formatMoney(note.vat) });
  totals.push({ label: t.noteTotal, value: formatMoney(note.total), strong: true });
  return {
    lang,
    shop: shopOf(settings),
    title: t.creditNote,
    meta,
    party: buyer(customer, t.customer),
    columns: lineColumns(lang, [0, 1, 2, 3, 6, 7, 8]),
    rows: note.lines.map((l, i) => [
      String(i + 1),
      lineName(l, lang),
      l.unitName,
      formatQuantity(l.quantity),
      formatMoney(l.net),
      settings.vatRegistered ? formatMoney(l.vat) : "",
      formatMoney(l.net + l.vat),
    ]),
    totals,
    words: amountInWords(note.total, lang),
    notes: note.reason,
  };
}

/** A price offer: the invoice's columns, the validity date, and no ledger effect. */
export function quotationA4(q: Quotation, settings: BusinessSettings, customer: Customer, lang: DocLang = "ar"): A4Document {
  const t = TEXT[lang];
  const meta = [
    { label: t.quotationNumber, value: String(q.number) },
    { label: t.date, value: q.date },
    { label: t.validUntil, value: q.validUntil },
  ];
  if (q.reference) meta.push({ label: t.customerReference, value: q.reference });
  const totals: A4Document["totals"] = [];
  if (q.discount > 0) {
    totals.push({ label: t.grossBeforeDiscount, value: formatMoney(q.gross) });
    totals.push({ label: t.discount, value: formatMoney(q.discount) });
  }
  totals.push({ label: t.netBeforeVat, value: formatMoney(q.net) });
  if (settings.vatRegistered) totals.push({ label: t.vat, value: formatMoney(q.vat) });
  totals.push({ label: t.total, value: formatMoney(q.total), strong: true });
  return {
    lang,
    shop: shopOf(settings),
    title: t.quotation,
    meta,
    party: buyer(customer, t.addressee),
    columns: lineColumns(lang),
    rows: q.lines.map((l, i) => [
      String(i + 1),
      lineName(l, lang),
      l.unitName,
      formatQuantity(l.quantity),
      formatMoney(l.unitPrice),
      l.discount > 0 ? formatMoney(l.discount) : "",
      formatMoney(l.net),
      settings.vatRegistered ? `${formatMoney(l.vat)} (${rate(l.vatRate)})` : "",
      formatMoney(l.net + l.vat),
    ]),
    totals,
    words: amountInWords(q.total, lang),
    notes: q.notes,
  };
}

/** What goes out with the goods: items, quantities and serials, without prices. */
export function deliveryNoteA4(invoice: SalesInvoice, settings: BusinessSettings, customer: Customer, lang: DocLang = "ar"): A4Document {
  const t = TEXT[lang];
  const meta = [
    { label: t.invoiceNumber, value: String(invoice.number) },
    { label: t.date, value: invoice.date },
  ];
  if (invoice.reference) meta.push({ label: t.customerReference, value: invoice.reference });
  return {
    lang,
    shop: shopOf(settings),
    title: t.deliveryNote,
    meta,
    party: buyer(customer, t.receiver),
    columns: lineColumns(lang, [0, 1, 2, 3]),
    rows: invoice.lines.map((l, i) => [String(i + 1), lineName(l, lang) + serialNote(l, lang), l.unitName, formatQuantity(l.quantity)]),
    totals: [],
    words: "",
    notes: [invoice.notes, t.received].filter(Boolean).join("\n\n"),
  };
}

/** A customer's or supplier's statement of account. */
export function statementA4(
  st: Statement,
  settings: BusinessSettings,
  party: { kind: "customer" | "supplier"; address: string; taxRegistrationNumber: string },
  lang: DocLang = "ar",
): A4Document {
  const t = TEXT[lang];
  const owed = party.kind === "customer" ? t.owedByCustomer : t.owedToSupplier;
  const balance = (n: number) => (n === 0 ? formatMoney(0) : `${formatMoney(Math.abs(n))} ${n > 0 ? "" : t.creditSide}`.trim());
  const [date, memo, debit, credit, running] = t.statementColumns;
  return {
    lang,
    shop: shopOf(settings),
    title: `${party.kind === "customer" ? t.customerStatement : t.supplierStatement}${st.currency === "EGP" ? "" : ` (${st.currency})`}`,
    meta: [
      { label: t.from, value: st.from },
      { label: t.to, value: st.to },
    ],
    party: { label: party.kind === "customer" ? t.customer : t.supplier, name: st.name, address: party.address, taxRegistrationNumber: party.taxRegistrationNumber },
    columns: [{ label: date! }, { label: memo! }, { label: debit!, numeric: true }, { label: credit!, numeric: true }, { label: running!, numeric: true }],
    rows: [
      [st.from, t.opening, "", "", balance(st.opening)],
      ...st.lines.map((l) => [l.date, l.memo, l.debit ? formatMoney(l.debit) : "", l.credit ? formatMoney(l.credit) : "", balance(l.balance)]),
    ],
    totals: [{ label: t.balanceOn(st.to, owed), value: balance(st.closing), strong: true }],
    words: st.closing > 0 ? amountInWords(st.closing, lang) : "",
    notes: "",
  };
}

const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

/** The page as HTML for Chromium to print or save as PDF. */
export function a4Html(doc: A4Document, fontCss = ""): string {
  const en = doc.lang === "en";
  const t = TEXT[en ? "en" : "ar"];
  const meta = doc.meta.map((m) => `<div><span class="muted">${escape(m.label)}:</span> <b dir="auto">${escape(m.value)}</b></div>`).join("\n");
  const party = doc.party
    ? `<section class="party"><div class="muted">${escape(doc.party.label)}</div><div class="name">${escape(doc.party.name)}</div>
${doc.party.address ? `<div>${escape(doc.party.address)}</div>` : ""}
${doc.party.taxRegistrationNumber ? `<div>${t.taxNumber}: <span dir="ltr">${escape(doc.party.taxRegistrationNumber)}</span></div>` : ""}</section>`
    : "";
  const head = doc.columns.map((c) => `<th${c.numeric ? ' class="num"' : ""}>${escape(c.label)}</th>`).join("");
  const rows = doc.rows
    .map((r) => `<tr>${r.map((cell, i) => `<td${doc.columns[i]?.numeric ? ' class="num" dir="ltr"' : ""}>${escape(cell)}</td>`).join("")}</tr>`)
    .join("\n");
  const totals = doc.totals
    .map((t) => `<tr${t.strong ? ' class="strong"' : ""}><th>${escape(t.label)}</th><td class="num" dir="ltr">${escape(t.value)}</td></tr>`)
    .join("\n");
  return `<!doctype html>
<html lang="${en ? "en" : "ar"}" dir="${en ? "ltr" : "rtl"}"><head><meta charset="utf-8"><style>
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
footer { margin-top: 40px; display: flex; justify-content: space-between; color: #555; }${
    en
      ? `
body { font-family: "Segoe UI", Tahoma, sans-serif; }
h1, .meta, .num { text-align: right !important; }
.lines th, .lines td, .totals th, .totals td { text-align: left; }`
      : ""
  }
</style></head><body>
<header>
<div class="shop"><div class="name">${escape(doc.shop.name)}</div>
${doc.shop.address ? `<div>${escape(doc.shop.address)}</div>` : ""}
${doc.shop.taxRegistrationNumber ? `<div>${t.taxNumber}: <span dir="ltr">${escape(doc.shop.taxRegistrationNumber)}</span></div>` : ""}</div>
<div><h1>${escape(doc.title)}</h1><div class="meta">${meta}</div></div>
</header>
${party}
<table class="lines"><thead><tr>${head}</tr></thead><tbody>
${rows}
</tbody></table>
<table class="totals">${totals}</table>
${doc.words ? `<div class="words">${escape(doc.words)}</div>` : ""}
${doc.notes ? `<div class="notes">${escape(doc.notes)}</div>` : ""}
<footer><span>${t.signature}: ....................</span><span>${t.stamp}</span></footer>
</body></html>`;
}
