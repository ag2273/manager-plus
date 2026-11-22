import { invoke } from "@tauri-apps/api/core";
import qrcode from "qrcode-generator";
import type { BusinessSettings } from "../../core/business";
import type { SaleReturn } from "../../core/returns";
import type { Receipt } from "../../core/sales";
import type { ZReport } from "../../core/shifts";
import type { BusinessMethod, Preferences, PrintRequest, Result } from "../../shared/api";
import { setDigitStyle } from "../../shared/digits";
import { type Bitmap, receiptJob } from "../../shared/escpos";
import { type PrintDocument, RECEIPT_WIDTH, returnDocument, saleDocument, testDocument, zReportDocument } from "../../shared/receipt";

/**
 * Receipt printing in the Tauri app (#75). The screens draw the receipt on a canvas one
 * receipt wide, the same layout as the Electron app's receipt page (`documentHtml`), and
 * turn it into a 1-bit ESC/POS raster; the Rust side only moves the bytes, to a network
 * printer on its port or to a Windows printer as a RAW job, which every 80 mm ESC/POS
 * printer takes, drawer kick included. A canvas, not a page drawn as an image: the
 * webview may not read back pixels of an HTML page, and the canvas shapes Arabic itself.
 */

const desktop = <T>(channel: string, ...args: unknown[]): Promise<T> => invoke<T>("desktop", { channel, args });

class Failed extends Error {
  constructor(readonly result: Result<never>) {
    super("failed");
  }
}

async function need<T>(method: BusinessMethod, ...args: unknown[]): Promise<T> {
  const result = await desktop<Result<T>>("call", method, args);
  if (!result.ok) throw new Failed(result);
  return result.value;
}

// The receipt page's sizes, in printer dots (see `documentHtml`).
const PAD_X = 12;
const PAD_TOP = 8;
const PAD_BOTTOM = 24;
const INNER = RECEIPT_WIDTH - PAD_X * 2;
const LEADING = 1.35;
const QR_SIZE = 240;
const FACE = '"IBM Plex Sans Arabic", Tahoma, "Segoe UI", sans-serif';
const LATIN_FACE = '"Segoe UI", Tahoma, sans-serif';

type Style = { size: number; weight: 400 | 600 | 700 };
const BODY: Style = { size: 24, weight: 400 };

/** The words of `text` in lines no wider than `width`, keeping its own line breaks. */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > width) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

/** Lays the document out top to bottom, drawing when `ctx` draws, and returns the height. */
function layout(ctx: CanvasRenderingContext2D, doc: PrintDocument, draw: boolean): number {
  const rtl = (doc.lang ?? "ar") !== "en";
  const face = rtl ? FACE : LATIN_FACE;
  const start = rtl ? RECEIPT_WIDTH - PAD_X : PAD_X;
  const end = rtl ? PAD_X : RECEIPT_WIDTH - PAD_X;
  let y = PAD_TOP;

  const use = (style: Style, ltr = false) => {
    ctx.font = `${style.weight} ${style.size}px ${face}`;
    ctx.direction = ltr || !rtl ? "ltr" : "rtl";
  };
  const text = (value: string, x: number, align: CanvasTextAlign, style: Style, ltr = false) => {
    use(style, ltr);
    ctx.textAlign = align;
    if (draw) ctx.fillText(value, x, y + (style.size * LEADING) / 2);
  };
  const centered = (value: string, style: Style) => {
    use(style);
    for (const line of wrap(ctx, value, INNER)) {
      text(line, RECEIPT_WIDTH / 2, "center", style);
      y += style.size * LEADING;
    }
  };
  // A row: the first part at the start (right in Arabic), the second at the end.
  const row = (first: string, second: string, style: Style, firstLtr = false, secondLtr = true) => {
    text(first, start, rtl ? "right" : "left", style, firstLtr);
    text(second, end, rtl ? "left" : "right", style, secondLtr);
    y += style.size * LEADING;
  };
  const rule = () => {
    y += 8;
    if (draw) {
      ctx.save();
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(PAD_X, y + 1);
      ctx.lineTo(RECEIPT_WIDTH - PAD_X, y + 1);
      ctx.stroke();
      ctx.restore();
    }
    y += 2 + 8;
  };

  const t = rtl
    ? { taxNumber: "رقم التسجيل الضريبي", number: "رقم", copy: "نسخة", cashier: "الكاشير" }
    : { taxNumber: "Tax registration no.", number: "No.", copy: "COPY", cashier: "Cashier" };
  centered(doc.shop.name, { size: 32, weight: 700 });
  if (doc.shop.address) centered(doc.shop.address, BODY);
  if (doc.shop.taxRegistrationNumber) centered(`${t.taxNumber}: ${doc.shop.taxRegistrationNumber}`, BODY);
  y += 6;
  centered(`${doc.title} ${t.number} ${doc.number}`, { size: 28, weight: 700 });
  if (doc.copy) {
    y += 6;
    const height = 2 + 24 * LEADING + 2 + 6;
    if (draw) {
      ctx.lineWidth = 3;
      ctx.strokeRect(PAD_X + 1.5, y + 1.5, INNER - 3, height - 3);
    }
    y += 3 + 2;
    centered(t.copy, { size: 24, weight: 700 });
    y += 2 + 3 + 6;
  }
  if (doc.reference) centered(doc.reference, BODY);
  // The date and time read left to right; the cashier's name in the document's own direction.
  row(doc.when, `${t.cashier}: ${doc.cashier}`, BODY, true, false);
  rule();
  if (doc.lines.length > 0) {
    for (const line of doc.lines) {
      const name: Style = { size: 24, weight: 600 };
      use(name);
      for (const part of wrap(ctx, line.name, INNER)) {
        text(part, start, rtl ? "right" : "left", name);
        y += 24 * LEADING;
      }
      row(line.detail, line.amount, BODY, true);
      y += 4;
    }
    rule();
  }
  for (const total of doc.totals) row(total.label, total.value, total.strong ? { size: 30, weight: 700 } : BODY);
  if (doc.qr) {
    rule();
    y += 4;
    if (draw) drawQr(ctx, doc.qr, (RECEIPT_WIDTH - QR_SIZE) / 2, y);
    y += QR_SIZE + 4;
  }
  if (doc.footer) {
    rule();
    y += 10;
    centered(doc.footer, BODY);
  }
  return Math.ceil(y + PAD_BOTTOM);
}

function drawQr(ctx: CanvasRenderingContext2D, link: string, left: number, top: number) {
  const code = qrcode(0, "M");
  code.addData(link, "Byte");
  code.make();
  const count = code.getModuleCount();
  const cell = QR_SIZE / (count + 8);
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (code.isDark(row, col)) {
        const x = Math.floor(left + (col + 4) * cell);
        const y = Math.floor(top + (row + 4) * cell);
        ctx.fillRect(x, y, Math.floor(left + (col + 5) * cell) - x, Math.floor(top + (row + 5) * cell) - y);
      }
    }
  }
}

/** The receipt drawn black on white, one receipt wide. */
export async function drawReceipt(doc: PrintDocument): Promise<Bitmap> {
  // The screens load the font lazily; make sure each weight's Arabic letters are in.
  await Promise.all([400, 600, 700].map((w) => document.fonts.load(`${w} 24px "IBM Plex Sans Arabic"`, "إيصال").catch(() => [])));
  const canvas = document.createElement("canvas");
  canvas.width = RECEIPT_WIDTH;
  canvas.height = 1;
  const height = layout(canvas.getContext("2d")!, doc, false);
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, RECEIPT_WIDTH, height);
  ctx.fillStyle = "#000";
  ctx.strokeStyle = "#000";
  ctx.textBaseline = "middle";
  layout(ctx, doc, true);
  const pixels = ctx.getImageData(0, 0, RECEIPT_WIDTH, height);
  return { width: RECEIPT_WIDTH, height, data: new Uint8Array(pixels.data.buffer) };
}

/** Builds the document for a print request from the open business. */
async function documentFor(request: PrintRequest, footer: string, lang: "ar" | "en"): Promise<PrintDocument> {
  const settings = await need<BusinessSettings>("settings");
  if (request.kind === "sale") return saleDocument(await need<Receipt>("findReceipt", request.number), settings, { footer, copy: request.copy }, lang);
  if (request.kind === "return") return returnDocument(await need<SaleReturn>("findReturn", request.number), settings, { footer, copy: request.copy }, lang);
  if (request.kind === "z") return zReportDocument(await need<ZReport>("zReport", request.shiftId), settings, lang);
  return testDocument(settings, footer, lang);
}

/** `DesktopApi.print` in the Tauri app. */
export async function tauriPrint(request: PrintRequest): Promise<Result<null>> {
  const { printer, documentLanguage, digits } = await desktop<Preferences>("preferences");
  setDigitStyle(digits);
  const footer = printer.kind === "none" ? "" : printer.footer;
  let doc: PrintDocument;
  try {
    doc = await documentFor(request, footer, documentLanguage);
  } catch (error) {
    if (error instanceof Failed) return error.result;
    throw error;
  }
  if (printer.kind === "none") return { ok: false, code: "printer_not_set", message: "No receipt printer is set up" };
  try {
    const bitmap = await drawReceipt(doc);
    // A Windows printer gets a RAW job, so the drawer opens from the job itself when cash was taken.
    const drawer = request.kind === "sale" && request.openDrawer && (printer.kind === "windows" || printer.openDrawer);
    return await desktop<Result<null>>("printRaw", printer, Array.from(receiptJob(bitmap, { openDrawer: drawer })));
  } catch (error) {
    console.error(error);
    return { ok: false, code: "printer_failed", message: String(error) };
  }
}
