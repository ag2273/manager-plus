import { qrSvg } from "./qr";
import type { BusinessSettings } from "./books/business";
import type { SaleReturn } from "./books/returns";
import type { Receipt } from "./books/sales";
import type { ZReport } from "./books/shifts";
import { formatMoney } from "./money";
import { serialNote } from "./serials";
import { formatQuantity } from "./quantity";

/** 80 mm paper at 203 dpi is 576 printable dots. */
export const RECEIPT_WIDTH = 576;

/** Everything printed on a receipt, already formatted. */
export type PrintDocument = {
  /** Arabic (right to left) unless set to English. */
  lang?: DocLang;
  shop: { name: string; address: string; taxRegistrationNumber: string };
  title: string;
  number: string;
  reference: string | null;
  when: string;
  cashier: string;
  copy: boolean;
  lines: { name: string; detail: string; amount: string }[];
  totals: { label: string; value: string; strong?: boolean }[];
  footer: string;
  /** The ETA e-receipt link, printed as a QR code, when the receipt is an e-receipt. */
  qr?: string;
};

export type DocLang = "ar" | "en";

/** The words printed on receipts, in each document language. */
const TEXT = {
  ar: {
    payments: { cash: "نقدي", card: "بطاقة", wallet: "محفظة / إنستاباي" } as Record<string, string>,
    grossBeforeDiscount: "الإجمالي قبل الخصم",
    discount: "الخصم",
    total: "الإجمالي",
    vatIncluded: "منها ضريبة القيمة المضافة",
    onCredit: "آجل على حساب العميل",
    change: "الباقي",
    sale: "إيصال بيع",
    returnTotal: "إجمالي المرتجع",
    refundCash: "رُد نقدًا",
    refundAccount: "أضيف لحساب العميل",
    return: "إيصال مرتجع",
    fromReceipt: (n: number) => `من إيصال بيع رقم ${n}`,
    test: "تجربة طابعة",
    testNote: "لو قريت العربي ده بوضوح، الطابعة جاهزة.",
    testItem: "أرز مصري 1 كجم",
    taxNumber: "رقم التسجيل الضريبي",
    number: "رقم",
    copy: "نسخة",
    cashier: "الكاشير",
    z: {
      title: "تقرير نهاية الوردية (Z)",
      receipts: "عدد الإيصالات",
      salesTotal: "إجمالي المبيعات",
      salesCash: "مبيعات نقدية",
      salesCard: "مبيعات بالبطاقة",
      salesWallet: "مبيعات بالمحفظة",
      salesCredit: "مبيعات آجلة",
      net: "صافي المبيعات قبل الضريبة",
      vat: "ضريبة القيمة المضافة",
      returns: "المرتجعات",
      discounts: "الخصومات",
      float: "رصيد أول الوردية",
      cashIn: "إيداع نقدية",
      cashOut: "سحب نقدية",
      expected: "النقدية المتوقعة",
      counted: "النقدية المعدودة",
      difference: "الفرق (زيادة + / عجز −)",
      open: "الوردية ما زالت مفتوحة",
    },
  },
  en: {
    payments: { cash: "Cash", card: "Card", wallet: "Wallet / InstaPay" } as Record<string, string>,
    grossBeforeDiscount: "Total before discount",
    discount: "Discount",
    total: "Total",
    vatIncluded: "Of which VAT",
    onCredit: "On the customer's account",
    change: "Change",
    sale: "Sales receipt",
    returnTotal: "Return total",
    refundCash: "Refunded in cash",
    refundAccount: "Credited to the customer's account",
    return: "Return receipt",
    fromReceipt: (n: number) => `For sales receipt no. ${n}`,
    test: "Printer test",
    testNote: "If you can read this clearly, the printer is ready.",
    testItem: "Egyptian rice 1 kg",
    taxNumber: "Tax registration no.",
    number: "no.",
    copy: "COPY",
    cashier: "Cashier",
    z: {
      title: "End of shift report (Z)",
      receipts: "Receipts",
      salesTotal: "Total sales",
      salesCash: "Cash sales",
      salesCard: "Card sales",
      salesWallet: "Wallet sales",
      salesCredit: "Sales on account",
      net: "Net sales before VAT",
      vat: "VAT",
      returns: "Returns",
      discounts: "Discounts",
      float: "Opening float",
      cashIn: "Cash in",
      cashOut: "Cash out",
      expected: "Expected cash",
      counted: "Counted cash",
      difference: "Difference (over + / short −)",
      open: "The shift is still open",
    },
  },
};

/** The item's English name on English documents, when it has one. */
export const lineName = (line: { nameAr: string; nameEn?: string }, lang: DocLang) => (lang === "en" && line.nameEn ? line.nameEn : line.nameAr);

function when(at: string): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function shopOf(settings: BusinessSettings): PrintDocument["shop"] {
  return { name: settings.name, address: settings.address, taxRegistrationNumber: settings.taxRegistrationNumber };
}

/** A till receipt as printed. */
export function saleDocument(receipt: Receipt, settings: BusinessSettings, options: { footer: string; copy: boolean }, lang: DocLang = "ar"): PrintDocument {
  const t = TEXT[lang];
  const gross = receipt.lines.reduce((t, l) => t + l.gross, 0);
  const discount = receipt.lines.reduce((t, l) => t + l.discount, 0);
  const totals: PrintDocument["totals"] = [];
  if (discount > 0) {
    totals.push({ label: t.grossBeforeDiscount, value: formatMoney(gross) });
    totals.push({ label: t.discount, value: `−${formatMoney(discount)}` });
  }
  totals.push({ label: t.total, value: formatMoney(receipt.total), strong: true });
  if (settings.vatRegistered) totals.push({ label: t.vatIncluded, value: formatMoney(receipt.vat) });
  for (const p of receipt.payments) {
    const amount = p.method === "cash" ? receipt.cashReceived : p.amount;
    totals.push({ label: t.payments[p.method] ?? p.method, value: formatMoney(amount) });
  }
  if (receipt.onCredit > 0) totals.push({ label: t.onCredit, value: formatMoney(receipt.onCredit) });
  if (receipt.change > 0) totals.push({ label: t.change, value: formatMoney(receipt.change) });
  return {
    lang,
    shop: shopOf(settings),
    title: t.sale,
    number: String(receipt.number),
    reference: null,
    when: when(receipt.at),
    cashier: receipt.soldBy,
    copy: options.copy,
    lines: receipt.lines.map((l) => ({
      name: lineName(l, lang) + serialNote(l, lang),
      detail: `${formatQuantity(l.quantity)} × ${formatMoney(l.unitPrice)}${l.discount > 0 ? ` − ${formatMoney(l.discount)}` : ""}`,
      amount: formatMoney(l.amount),
    })),
    totals,
    footer: options.footer,
  };
}

/** A return receipt, pointing back to the sale it came from. */
export function returnDocument(ret: SaleReturn, settings: BusinessSettings, options: { footer: string; copy: boolean }, lang: DocLang = "ar"): PrintDocument {
  const t = TEXT[lang];
  const totals: PrintDocument["totals"] = [{ label: t.returnTotal, value: formatMoney(ret.total), strong: true }];
  if (settings.vatRegistered) totals.push({ label: t.vatIncluded, value: formatMoney(ret.vat) });
  totals.push({ label: ret.refund === "cash" ? t.refundCash : t.refundAccount, value: formatMoney(ret.total) });
  return {
    lang,
    shop: shopOf(settings),
    title: t.return,
    number: String(ret.number),
    reference: t.fromReceipt(ret.receiptNumber),
    when: when(ret.at),
    cashier: ret.returnedBy,
    copy: options.copy,
    lines: ret.lines.map((l) => ({ name: lineName(l, lang), detail: formatQuantity(l.quantity), amount: formatMoney(l.amount) })),
    totals,
    footer: options.footer,
  };
}

/** A sample receipt for the printer setup's test print. */
export function testDocument(settings: BusinessSettings, footer: string, lang: DocLang = "ar"): PrintDocument {
  const t = TEXT[lang];
  return {
    lang,
    shop: shopOf(settings),
    title: t.test,
    number: "0",
    reference: t.testNote,
    when: when(new Date().toISOString()),
    cashier: "—",
    copy: false,
    lines: [{ name: t.testItem, detail: `${formatQuantity(2_000)} × ${formatMoney(3_800)}`, amount: formatMoney(7_600) }],
    totals: [{ label: t.total, value: formatMoney(7_600), strong: true }],
    footer,
  };
}

/** The end of shift (Z) report, on receipt paper. */
export function zReportDocument(report: ZReport, settings: BusinessSettings, lang: DocLang = "ar"): PrintDocument {
  const z = TEXT[lang].z;
  const money = (v: number | null) => (v === null ? "—" : formatMoney(v));
  const rows: [string, string][] = [
    [z.receipts, formatQuantity(report.receipts * 1000)],
    [z.salesTotal, money(report.sales.total)],
    [z.salesCash, money(report.sales.byMethod.cash)],
    [z.salesCard, money(report.sales.byMethod.card)],
    [z.salesWallet, money(report.sales.byMethod.wallet)],
    [z.salesCredit, money(report.sales.byMethod.credit)],
    [z.net, money(report.sales.net)],
    [z.vat, money(report.sales.vat)],
    [z.returns, money(report.returns)],
    [z.discounts, money(report.discounts)],
    [z.float, money(report.openingFloat)],
    [z.cashIn, money(report.cashIn)],
    [z.cashOut, money(report.cashOut)],
    [z.expected, money(report.expectedCash)],
    [z.counted, money(report.countedCash)],
  ];
  return {
    lang,
    shop: shopOf(settings),
    title: z.title,
    number: String(report.shift.id),
    reference: report.shift.closedAt ? `${when(report.shift.openedAt)} → ${when(report.shift.closedAt)}` : z.open,
    when: when(report.shift.closedAt ?? report.shift.openedAt),
    cashier: report.shift.userName,
    copy: false,
    lines: [],
    totals: [...rows.map(([label, value]) => ({ label, value })), { label: z.difference, value: money(report.difference), strong: true }],
    footer: "",
  };
}

const escape = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

/** The receipt as a page exactly one receipt wide, black on white, for Chromium to draw. */
export function documentHtml(doc: PrintDocument, fontCss = ""): string {
  const lang = doc.lang ?? "ar";
  const t = TEXT[lang];
  const rows = doc.lines
    .map(
      (l) => `<div class="line"><div class="name">${escape(l.name)}</div>
<div class="row"><span class="detail" dir="ltr">${escape(l.detail)}</span><span class="num" dir="ltr">${escape(l.amount)}</span></div></div>`,
    )
    .join("\n");
  const totals = doc.totals
    .map((t) => `<div class="row${t.strong ? " strong" : ""}"><span>${escape(t.label)}</span><span class="num" dir="ltr">${escape(t.value)}</span></div>`)
    .join("\n");
  return `<!doctype html>
<html lang="${lang}" dir="${lang === "en" ? "ltr" : "rtl"}"><head><meta charset="utf-8"><style>
${fontCss}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: ${RECEIPT_WIDTH}px; background: #fff; color: #000; }
body { font-family: ${lang === "en" ? '"Segoe UI", Tahoma, sans-serif' : '"IBM Plex Sans Arabic", Tahoma, "Segoe UI", sans-serif'}; font-size: 24px; line-height: 1.35; padding: 8px 12px 24px; }
.center { text-align: center; }
.shop { font-size: 32px; font-weight: 700; }
.title { font-size: 28px; font-weight: 700; margin-top: 6px; }
.copy { border: 3px solid #000; font-weight: 700; padding: 2px 0; margin: 6px 0; }
.rule { border-top: 2px dashed #000; margin: 8px 0; }
.row { display: flex; justify-content: space-between; gap: 12px; }
.line { margin-bottom: 4px; }
.name { font-weight: 600; white-space: pre-line; }
.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
.strong { font-size: 30px; font-weight: 700; }
.footer { margin-top: 10px; white-space: pre-line; }
.qr svg { display: block; margin: 4px auto; }
</style></head><body>
<div class="center shop">${escape(doc.shop.name)}</div>
${doc.shop.address ? `<div class="center">${escape(doc.shop.address)}</div>` : ""}
${doc.shop.taxRegistrationNumber ? `<div class="center">${t.taxNumber}: <span dir="ltr">${escape(doc.shop.taxRegistrationNumber)}</span></div>` : ""}
<div class="center title">${escape(doc.title)} ${t.number} ${escape(doc.number)}</div>
${doc.copy ? `<div class="center copy">${t.copy}</div>` : ""}
${doc.reference ? `<div class="center">${escape(doc.reference)}</div>` : ""}
<div class="row"><span dir="ltr">${escape(doc.when)}</span><span>${t.cashier}: ${escape(doc.cashier)}</span></div>
<div class="rule"></div>
${rows ? `${rows}\n<div class="rule"></div>` : ""}
${totals}
${doc.qr ? `<div class="rule"></div><div class="center qr">${qrSvg(doc.qr)}</div>\n` : ""}${doc.footer ? `<div class="rule"></div><div class="center footer">${escape(doc.footer)}</div>` : ""}
</body></html>`;
}
