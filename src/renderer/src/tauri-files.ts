import type { A4Request, Preferences, Result } from "../../shared/api";
import { a4Html, creditNoteA4, deliveryNoteA4, invoiceA4, quotationA4, statementA4, type A4Document } from "../../shared/a4";
import type { BusinessSettings } from "../../shared/books/business";
import type { Customer } from "../../shared/books/customers";
import type { CreditNote, SalesInvoice } from "../../shared/books/invoices";
import type { Supplier } from "../../shared/books/purchases";
import type { Quotation } from "../../shared/books/quotations";
import type { Statement } from "../../shared/books/settlements";
import { setDigitStyle } from "../../shared/digits";
import { importTemplate } from "../../shared/import-template";
import { type Lang, type ReportTable, reportA4, reportSheet } from "../../shared/report-tables";
import { type ReadSheet, decodeCsv, parseCsv, readXlsxAsync } from "../../shared/spreadsheet-read";
import { xlsx } from "../../shared/xlsx";
import { Failed, desktop, need } from "./tauri-print";

/**
 * The A4 documents, Excel exports and the import's spreadsheets in the Tauri app (#97, note 4).
 * The screens' side builds the files from the core's answers, as the Electron main process did;
 * the Rust side only asks where to save or what to open, writes and reads the bytes, and turns
 * an A4 page into a PDF in WebView2.
 */

type Saved = Result<{ saved: string | null }>;

/** A name Windows accepts for a file. */
const fileName = (name: string) => name.replace(/[\\/:*?"<>|]/g, "-").trim();

/** Asks where to save `bytes` (suggesting `name`) and writes them; the path, or null when cancelled. */
async function save(name: string, filter: string, extension: string, bytes: Uint8Array): Promise<Saved> {
  const saved = await desktop<Result<string | null>>("saveFile", `${fileName(name)}.${extension}`, filter, [extension], Array.from(bytes));
  return saved.ok ? { ok: true, value: { saved: saved.value } } : saved;
}

export function tauriExportExcel(table: ReportTable): Promise<Saved> {
  return save(`${table.title} ${table.meta.map((m) => m.value).join(" ")}`, "Excel", "xlsx", xlsx(reportSheet(table)));
}

export function tauriSaveImportTemplate(lang: Lang): Promise<Saved> {
  const name = lang === "ar" ? "نموذج استيراد الأصناف والأرصدة" : "Items and balances import template";
  return save(name, "Excel", "xlsx", importTemplate(lang));
}

/** Raw deflate (zip method 8) through the webview's own decompressor. */
async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function tauriOpenSpreadsheet(): Promise<Result<{ name: string; sheets: ReadSheet[] } | null>> {
  const opened = await desktop<Result<{ name: string; bytes: number[] } | null>>("openFile", "Excel / CSV", ["xlsx", "csv"]);
  if (!opened.ok || !opened.value) return opened as Result<null>;
  const { name } = opened.value;
  const bytes = new Uint8Array(opened.value.bytes);
  try {
    const sheets = /\.csv$/i.test(name) ? [{ name, rows: parseCsv(decodeCsv(bytes)) }] : await readXlsxAsync(bytes, inflate);
    return { ok: true, value: { name, sheets } };
  } catch (error) {
    console.error(error);
    return { ok: false, code: "spreadsheet_unreadable", message: String(error) };
  }
}

let fontCss: Promise<string> | null = null;

/** The Arabic font, embedded so the page draws the same on every PC; loaded only when an A4 page is made. */
function embeddedFont(): Promise<string> {
  fontCss ??= import("./a4-font").then((m) => m.A4_FONT_CSS);
  return fontCss;
}

/** The page for an A4 request, built from the open business, and the name it is saved under. */
async function pageFor(request: A4Request, lang: Lang): Promise<{ doc: A4Document; name: string }> {
  const settings = await need<BusinessSettings>("settings");
  const customer = async (id: number) => (await need<Customer[]>("customers")).find((c) => c.id === id)!;
  const named = (doc: A4Document, number: number | string) => ({ doc, name: `${doc.title} ${number}` });
  switch (request.kind) {
    case "invoice": {
      const invoice = await need<SalesInvoice>("findSalesInvoice", request.number);
      return named(invoiceA4(invoice, settings, await customer(invoice.customerId), lang), invoice.number);
    }
    case "creditNote": {
      const note = await need<CreditNote>("findCreditNote", request.number);
      return named(creditNoteA4(note, settings, await customer(note.customerId), lang), note.number);
    }
    case "deliveryNote": {
      const invoice = await need<SalesInvoice>("findSalesInvoice", request.number);
      return named(deliveryNoteA4(invoice, settings, await customer(invoice.customerId), lang), invoice.number);
    }
    case "quotation": {
      const quotation = await need<Quotation>("findQuotation", request.number, new Date().toLocaleDateString("en-CA"));
      return named(quotationA4(quotation, settings, await customer(quotation.customerId), lang), quotation.number);
    }
    case "report":
      return { doc: reportA4(request.table, settings), name: `${request.table.title} ${request.table.meta.map((m) => m.value).join(" ")}` };
    case "statement": {
      const st = await need<Statement>("statement", request.party, request.id, request.from, request.to);
      const party =
        request.party === "customer"
          ? (await need<Customer[]>("customers")).find((c) => c.id === request.id)!
          : (await need<Supplier[]>("suppliers")).find((x) => x.id === request.id)!;
      const details = { kind: request.party, address: "address" in party ? party.address : "", taxRegistrationNumber: party.taxRegistrationNumber };
      return named(statementA4(st, settings, details, lang), `${st.name} ${st.to}`);
    }
  }
}

/** Prints `html` through the system print dialog, from a frame of its own off the screen. */
async function printFrame(html: string): Promise<void> {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;inset-inline-start:-10000px;top:0;width:210mm;height:297mm;border:0;";
  const loaded = new Promise<void>((done) => frame.addEventListener("load", () => done(), { once: true }));
  frame.srcdoc = html;
  document.body.append(frame);
  try {
    await loaded;
    const page = frame.contentWindow!;
    await page.document.fonts.ready;
    page.focus();
    page.print();
  } finally {
    // The dialog holds the page until it closes; give it a moment before taking the frame away.
    setTimeout(() => frame.remove(), 1000);
  }
}

export async function tauriPrintA4(request: A4Request): Promise<Saved> {
  const { documentLanguage, digits } = await desktop<Preferences>("preferences");
  setDigitStyle(digits);
  let page: { doc: A4Document; name: string };
  try {
    page = await pageFor(request, documentLanguage);
  } catch (error) {
    if (error instanceof Failed) return error.result;
    throw error;
  }
  const html = a4Html(page.doc, await embeddedFont());
  if (request.output === "pdf") {
    const saved = await desktop<Result<string | null>>("savePdf", html, `${fileName(page.name)}.pdf`);
    return saved.ok ? { ok: true, value: { saved: saved.value } } : saved;
  }
  try {
    await printFrame(html);
    return { ok: true, value: { saved: null } };
  } catch (error) {
    console.error(error);
    return { ok: false, code: "printer_failed", message: String(error) };
  }
}
