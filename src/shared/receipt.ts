import type { BusinessSettings } from "../core/business";
import type { SaleReturn } from "../core/returns";
import type { Receipt } from "../core/sales";
import { formatMoney } from "./money";
import { serialNote } from "./serials";
import { formatQuantity } from "./quantity";

/** 80 mm paper at 203 dpi is 576 printable dots. */
export const RECEIPT_WIDTH = 576;

/** Everything printed on a receipt, already formatted. */
export type PrintDocument = {
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
};

const PAYMENT_LABELS: Record<string, string> = { cash: "نقدي", card: "بطاقة", wallet: "محفظة / إنستاباي" };

function when(at: string): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function shopOf(settings: BusinessSettings): PrintDocument["shop"] {
  return { name: settings.name, address: settings.address, taxRegistrationNumber: settings.taxRegistrationNumber };
}

/** A till receipt as printed. */
export function saleDocument(receipt: Receipt, settings: BusinessSettings, options: { footer: string; copy: boolean }): PrintDocument {
  const gross = receipt.lines.reduce((t, l) => t + l.gross, 0);
  const discount = receipt.lines.reduce((t, l) => t + l.discount, 0);
  const totals: PrintDocument["totals"] = [];
  if (discount > 0) {
    totals.push({ label: "الإجمالي قبل الخصم", value: formatMoney(gross) });
    totals.push({ label: "الخصم", value: `−${formatMoney(discount)}` });
  }
  totals.push({ label: "الإجمالي", value: formatMoney(receipt.total), strong: true });
  if (settings.vatRegistered) totals.push({ label: "منها ضريبة القيمة المضافة", value: formatMoney(receipt.vat) });
  for (const p of receipt.payments) {
    const amount = p.method === "cash" ? receipt.cashReceived : p.amount;
    totals.push({ label: PAYMENT_LABELS[p.method] ?? p.method, value: formatMoney(amount) });
  }
  if (receipt.onCredit > 0) totals.push({ label: "آجل على حساب العميل", value: formatMoney(receipt.onCredit) });
  if (receipt.change > 0) totals.push({ label: "الباقي", value: formatMoney(receipt.change) });
  return {
    shop: shopOf(settings),
    title: "إيصال بيع",
    number: String(receipt.number),
    reference: null,
    when: when(receipt.at),
    cashier: receipt.soldBy,
    copy: options.copy,
    lines: receipt.lines.map((l) => ({
      name: l.nameAr + serialNote(l),
      detail: `${formatQuantity(l.quantity)} × ${formatMoney(l.unitPrice)}${l.discount > 0 ? ` − ${formatMoney(l.discount)}` : ""}`,
      amount: formatMoney(l.amount),
    })),
    totals,
    footer: options.footer,
  };
}

/** A return receipt, pointing back to the sale it came from. */
export function returnDocument(ret: SaleReturn, settings: BusinessSettings, options: { footer: string; copy: boolean }): PrintDocument {
  const totals: PrintDocument["totals"] = [{ label: "إجمالي المرتجع", value: formatMoney(ret.total), strong: true }];
  if (settings.vatRegistered) totals.push({ label: "منها ضريبة القيمة المضافة", value: formatMoney(ret.vat) });
  totals.push({ label: ret.refund === "cash" ? "رُد نقدًا" : "أضيف لحساب العميل", value: formatMoney(ret.total) });
  return {
    shop: shopOf(settings),
    title: "إيصال مرتجع",
    number: String(ret.number),
    reference: `من إيصال بيع رقم ${ret.receiptNumber}`,
    when: when(ret.at),
    cashier: ret.returnedBy,
    copy: options.copy,
    lines: ret.lines.map((l) => ({ name: l.nameAr, detail: formatQuantity(l.quantity), amount: formatMoney(l.amount) })),
    totals,
    footer: options.footer,
  };
}

/** A sample receipt for the printer setup's test print. */
export function testDocument(settings: BusinessSettings, footer: string): PrintDocument {
  return {
    shop: shopOf(settings),
    title: "تجربة طابعة",
    number: "0",
    reference: "لو قريت العربي ده بوضوح، الطابعة جاهزة.",
    when: when(new Date().toISOString()),
    cashier: "—",
    copy: false,
    lines: [{ name: "أرز مصري 1 كجم", detail: "2 × 38.00", amount: "76.00" }],
    totals: [{ label: "الإجمالي", value: "76.00", strong: true }],
    footer,
  };
}

const escape = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

/** The receipt as a page exactly one receipt wide, black on white, for Chromium to draw. */
export function documentHtml(doc: PrintDocument, fontCss = ""): string {
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
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>
${fontCss}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: ${RECEIPT_WIDTH}px; background: #fff; color: #000; }
body { font-family: "IBM Plex Sans Arabic", Tahoma, "Segoe UI", sans-serif; font-size: 24px; line-height: 1.35; padding: 8px 12px 24px; }
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
</style></head><body>
<div class="center shop">${escape(doc.shop.name)}</div>
${doc.shop.address ? `<div class="center">${escape(doc.shop.address)}</div>` : ""}
${doc.shop.taxRegistrationNumber ? `<div class="center">رقم التسجيل الضريبي: <span dir="ltr">${escape(doc.shop.taxRegistrationNumber)}</span></div>` : ""}
<div class="center title">${escape(doc.title)} رقم ${escape(doc.number)}</div>
${doc.copy ? `<div class="center copy">نسخة</div>` : ""}
${doc.reference ? `<div class="center">${escape(doc.reference)}</div>` : ""}
<div class="row"><span dir="ltr">${escape(doc.when)}</span><span>الكاشير: ${escape(doc.cashier)}</span></div>
<div class="rule"></div>
${rows}
<div class="rule"></div>
${totals}
${doc.footer ? `<div class="rule"></div><div class="center footer">${escape(doc.footer)}</div>` : ""}
</body></html>`;
}
