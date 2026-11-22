import { app, BrowserWindow, dialog, ipcMain, safeStorage } from "electron";
import { cancelDocument, refreshReceiptStatuses, refreshStatuses, sendPending, sendReceipts } from "../core/eta/sender";
import type { EtaReceiptSettingsInput } from "../core/eta/receipts-store";
import type { EtaKind, EtaSettingsInput } from "../core/eta/store";
import { httpEtaClient, httpEtaReceiptClient, listCertificates, windowsTokenSigner } from "./eta";
import { Licensing, type LicenceStatus } from "../core/licence/licence";
import { LICENCE_PUBLIC_KEY } from "../core/licence/public-key";
import { LICENCE_SERVER, fileLicenceStore, httpLicenceClient, machineFingerprint } from "./licence";
import { type UpdateCheck, checkUpdate } from "../core/updates";
import { UPDATE_PUBLIC_KEY } from "../core/update-key";
import { downloadInstaller, fetchManifest, runInstaller } from "./updates";
import { readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { Business, type BusinessSettings } from "../core/business";
import type { Credentials } from "../core/users";
import { BusinessError } from "../core/errors";
import {
  BUSINESS_METHODS,
  CHANNELS,
  DEFAULT_PREFERENCES,
  NO_PRINTER,
  THEMES,
  type BusinessMethod,
  type Preferences,
  type PrinterSettings,
  type PrintRequest,
  type A4Request,
  type Connection,
  type FoundServer,
  type Result,
  type ServerStatus,
} from "../shared/api";
import type { Customer } from "../core/customers";
import type { Supplier } from "../core/purchases";
import type { CreditNote, SalesInvoice } from "../core/invoices";
import type { Quotation } from "../core/quotations";
import type { Statement } from "../core/settlements";
import type { Receipt } from "../core/sales";
import type { SaleReturn } from "../core/returns";
import { loadOrCreateIdentity, shortFingerprint } from "../server/certificate";
import { ConnectError, RemoteBusiness } from "../server/client";
import { advertise, discover } from "../server/discovery";
import { type RunningServer, startServer } from "../server/server";
import { DEFAULT_PORT } from "../server/protocol";
import { documentHtml, returnDocument, saleDocument, testDocument, zReportDocument } from "../shared/receipt";
import type { ZReport } from "../core/shifts";
import { listPrinters, printA4, printHtml } from "./printer";
import { a4Html, creditNoteA4, deliveryNoteA4, invoiceA4, quotationA4, statementA4, type A4Document } from "../shared/a4";
import { setDigitStyle } from "../shared/digits";
import { type ReportTable, reportA4, reportSheet } from "../shared/report-tables";
import { xlsx } from "../shared/xlsx";
import { importTemplate } from "../shared/import-template";
import { decodeCsv, parseCsv, readXlsx } from "../shared/spreadsheet-read";
import { inflateRawSync } from "node:zlib";
import { basename } from "node:path";
import { hostname } from "node:os";
import { type LockInfo, refreshLock, releaseLock, syncFolder, takeLock } from "../core/file-lock";

const FILE_FILTER = { name: "Manager+ business", extensions: ["mplus"] };
const MAX_RECENT = 8;

/** The open business file, signed out, and the same business acting for the signed-in user. */
let file: Business | null = null;
let current: Business | null = null;
let localPath: string | null = null;
/** The business on another PC, when this one is a client. */
let remote: RemoteBusiness | null = null;
/** This PC serving its open file to others. */
let serving: { server: RunningServer; stopAdvertising: () => void } | null = null;
let window: BrowserWindow | null = null;
/** This PC in the lock file next to the open business file. */
const ME = { host: hostname(), pid: process.pid };
/** Another PC that had the open file when this one opened it. */
let openElsewhere: LockInfo | null = null;

/** Lets go of the open file's lock, if this PC has one. */
function unlock(): void {
  if (localPath) releaseLock(localPath, ME);
  openElsewhere = null;
}

/** The daily backup of the file this PC holds, while it is open; failures are logged and tried again later. */
function backupIfDue(): void {
  if (!file || remote) return;
  try {
    const done = file.scheduledBackup(new Date());
    if (done) console.log(`Backed up to ${done.path}`);
  } catch (error) {
    console.error("Scheduled backup failed", error);
  }
}

/** The ETA client and token signer for the file this PC holds, or null when e-invoicing is off or this PC is a client. */
function etaLink() {
  if (!file || remote) return null;
  let credentials;
  try {
    credentials = file.etaCredentials();
  } catch {
    return null;
  }
  const clientSecret = safeStorage.decryptString(Buffer.from(credentials.clientSecret, "base64"));
  return { client: httpEtaClient({ ...credentials, clientSecret }), signer: windowsTokenSigner(credentials.certificate) };
}

/** The e-receipt client for the POS this file is registered as, or null when e-receipts are off or this PC is a client. */
function etaReceiptLink() {
  if (!file || remote) return null;
  let credentials;
  try {
    credentials = file.etaReceiptCredentials();
  } catch {
    return null;
  }
  const unseal = (sealed: string) => safeStorage.decryptString(Buffer.from(sealed, "base64"));
  return httpEtaReceiptClient({ ...credentials, posClientSecret: unseal(credentials.posClientSecret), presharedKey: unseal(credentials.presharedKey) });
}

let licensing: Licensing | null = null;

/** This PC's licence, read once the app's data folder is known. */
async function loadLicensing(): Promise<Licensing> {
  licensing ??= new Licensing({
    store: fileLicenceStore(join(app.getPath("userData"), "licence.json")),
    client: httpLicenceClient(undefined, app.getVersion()),
    publicKeyPem: LICENCE_PUBLIC_KEY,
    machine: await machineFingerprint(),
  });
  return licensing;
}

/** Applies this PC's licence to the file it holds: read-only without one, and the number of users. */
function applyLicence(): void {
  if (!file || remote || !licensing) return;
  file.setLicenceLimits(licensing.limits(new Date()));
}

let etaRunning: Promise<number> | null = null;

/**
 * Asks the ETA about submitted documents and e-receipts, then sends the pending ones: invoices
 * signed with the token, receipts in the till's order. Runs in the background after each posting
 * and every few minutes; posting never waits on it. Invoices failing don't hold receipts back.
 */
function etaCycle(): Promise<number> {
  etaRunning ??= (async () => {
    try {
      if (!file) return 0;
      let sent = 0;
      let failed: unknown = null;
      const link = etaLink();
      if (link) {
        try {
          await refreshStatuses(file.etaBooks(), link.client);
          sent += await sendPending(file.etaBooks(), link.signer, link.client);
        } catch (error) {
          failed = error;
        }
      }
      const receipts = etaReceiptLink();
      if (receipts) {
        try {
          await refreshReceiptStatuses(file.etaReceiptBooks(), receipts);
          sent += await sendReceipts(file.etaReceiptBooks(), receipts);
        } catch (error) {
          failed ??= error;
        }
      }
      if (failed) throw failed;
      return sent;
    } finally {
      etaRunning = null;
    }
  })();
  return etaRunning;
}

setInterval(
  () => {
    if (localPath && file) refreshLock(localPath, ME, new Date());
    applyLicence();
    backupIfDue();
    etaCycle().catch((error) => console.error("E-invoice sending failed", error));
  },
  5 * 60 * 1000,
);

function recentPath(): string {
  return join(app.getPath("userData"), "recent-files.json");
}

function readRecent(): string[] {
  try {
    const list: unknown = JSON.parse(readFileSync(recentPath(), "utf8"));
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function rememberRecent(path: string): void {
  const list = [path, ...readRecent().filter((p) => p !== path)].slice(0, MAX_RECENT);
  writeFileSync(recentPath(), JSON.stringify(list));
}

function switchTo(business: Business, path: string): BusinessSettings {
  void stopServing();
  remote?.close();
  remote = null;
  unlock();
  file?.close();
  file = business;
  localPath = path;
  try {
    openElsewhere = takeLock(path, ME, new Date());
  } catch (error) {
    // A read-only folder: no lock, but the file still opens.
    console.error(error);
  }
  licensing?.noteFile(business.startedAt(), new Date());
  applyLicence();
  backupIfDue();
  current = business.currentUser() ? business : null;
  rememberRecent(path);
  const serve = readNetwork().serve;
  if (serve && serve.path === path) void startServing(serve.port).catch((error) => console.error(error));
  return business.settings();
}

function failure(error: unknown): { ok: false; code: string; message: string; amount?: number } {
  if (error instanceof BusinessError) {
    return { ok: false, code: error.code, message: error.message, ...(error.amount === undefined ? {} : { amount: error.amount }) };
  }
  console.error(error);
  return { ok: false, code: "unexpected", message: String(error) };
}

function attempt<T>(work: () => T): Result<T> {
  try {
    return { ok: true, value: work() };
  } catch (error) {
    return failure(error);
  }
}

ipcMain.handle(CHANNELS.createBusiness, async (_event, settings: BusinessSettings, manager: Credentials) => {
  const target = await dialog.showSaveDialog(window!, {
    defaultPath: `${settings.name || "business"}.mplus`,
    filters: [FILE_FILTER],
  });
  if (target.canceled || !target.filePath) return { ok: true, value: null };
  const path = target.filePath;
  return attempt(() => switchTo(Business.create(path, settings, manager), path));
});

ipcMain.handle(CHANNELS.openBusiness, async (_event, given?: string) => {
  let path = given;
  if (!path) {
    const picked = await dialog.showOpenDialog(window!, { properties: ["openFile"], filters: [FILE_FILTER] });
    if (picked.canceled || !picked.filePaths[0]) return { ok: true, value: null };
    path = picked.filePaths[0];
  }
  const chosen = path;
  return attempt(() => switchTo(Business.open(chosen), chosen));
});

ipcMain.handle(CHANNELS.recentFiles, () => readRecent());

ipcMain.handle(CHANNELS.signIn, async (_event, credentials: Credentials) => {
  if (remote) return remote.signIn(credentials);
  if (!file) return { ok: false, code: "unexpected", message: "No business is open" };
  const opened = file;
  return attempt(() => {
    current = opened.signIn(credentials.name, credentials.password);
    return current.currentUser();
  });
});

ipcMain.handle(CHANNELS.signOut, async () => {
  // The file itself stays signed in when it was just created; only a sign-in made here ends.
  if (current && current !== file) current.signOut();
  current = null;
  await remote?.signOut();
});

/** A facade call on the open business, here or on the server. */
function call<T>(method: BusinessMethod, args: unknown[]): Promise<Result<T>> {
  if (remote) return remote.call<T>(method, args);
  if (!current) return Promise.resolve({ ok: false, code: "sign_in_required", message: "Sign in first" });
  const business = current;
  return Promise.resolve(attempt(() => (business[method] as (...a: unknown[]) => unknown).apply(business, args) as T));
}

/** A failed call, carried out of a chain of calls as its result. */
class Failed extends Error {
  constructor(readonly result: { ok: false; code: string; message: string }) {
    super(result.message);
  }
}

async function need<T>(method: BusinessMethod, ...args: unknown[]): Promise<T> {
  const result = await call<T>(method, args);
  if (!result.ok) throw new Failed(result);
  return result.value;
}

/** Postings that may queue an e-invoice or e-receipt, so the ETA cycle runs after them. */
const ETA_POSTINGS = new Set<BusinessMethod>(["postSalesInvoice", "postCreditNote", "postSale", "postCashSale", "returnSale"]);

ipcMain.handle(CHANNELS.call, (_event, method: BusinessMethod, args: unknown[]) => {
  if (!BUSINESS_METHODS.includes(method) || !Array.isArray(args)) {
    return { ok: false, code: "unexpected", message: `Not a business method: ${String(method)}` };
  }
  const result = call(method, args);
  if (ETA_POSTINGS.has(method)) {
    void result.then((r) => {
      if (r.ok) etaCycle().catch((error) => console.error("E-invoice sending failed", error));
    });
  }
  return result;
});

ipcMain.handle(CHANNELS.saveEtaReceiptSettings, (_event, input: EtaReceiptSettingsInput) => {
  const business = etaManager();
  if (!business) return { ok: false, code: "restore_needs_manager", message: "Only a manager on the PC that holds the file sets up e-receipts" };
  const settings: EtaReceiptSettingsInput = { ...input };
  delete settings.posClientSecret;
  delete settings.presharedKey;
  const secret = input.posClientSecret?.trim();
  const key = input.presharedKey?.trim();
  if ((secret || key) && !safeStorage.isEncryptionAvailable()) return { ok: false, code: "unexpected", message: "This PC can't seal the POS secrets" };
  if (secret) settings.posClientSecret = safeStorage.encryptString(secret).toString("base64");
  if (key) settings.presharedKey = safeStorage.encryptString(key).toString("base64");
  return attempt(() => {
    business.setEtaReceiptSettings(settings);
    return null;
  });
});

/** This PC's licence; a PC using another's file is covered by that server's licence. */
ipcMain.handle(CHANNELS.licenceStatus, async (): Promise<LicenceStatus | null> => {
  if (remote) return null;
  return (await loadLicensing()).status(new Date());
});

ipcMain.handle(CHANNELS.activateLicence, async (_event, key: string): Promise<Result<LicenceStatus>> => {
  if (remote) return { ok: false, code: "not_allowed", message: "Activate on the PC that holds the file" };
  try {
    const status = await (await loadLicensing()).activate(String(key), new Date());
    applyLicence();
    return { ok: true, value: status };
  } catch (error) {
    return failure(error);
  }
});

let lastUpdateCheck: UpdateCheck | null = null;

/** Asks our server for the newest release and whether this licence may install it. */
async function updateCheck(): Promise<UpdateCheck> {
  const signed = await fetchManifest(LICENCE_SERVER);
  const licence = await loadLicensing();
  lastUpdateCheck = signed
    ? checkUpdate(signed, { publicKeyPem: UPDATE_PUBLIC_KEY, currentVersion: app.getVersion(), allowed: (date) => licence.updateAllowed(date, new Date()) })
    : { kind: "none" };
  return lastUpdateCheck;
}

ipcMain.handle(CHANNELS.appVersion, () => app.getVersion());

ipcMain.handle(CHANNELS.checkUpdate, async (_event, cached: boolean): Promise<Result<UpdateCheck>> => {
  // The screens' banner asks for the last answer only; the network is asked at start and on the Settings button.
  if (cached) return { ok: true, value: lastUpdateCheck ?? { kind: "none" } };
  try {
    return { ok: true, value: await updateCheck() };
  } catch (error) {
    return failure(error);
  }
});

/**
 * Installs the newest eligible update: downloads it, checks it against the signed manifest,
 * backs up the business file this PC holds, then runs the installer and quits. A manager does it.
 */
ipcMain.handle(CHANNELS.installUpdate, async (): Promise<Result<null>> => {
  const me = await call<{ role: string } | null>("currentUser", []);
  const role = me.ok ? me.value?.role : null;
  if (role !== "manager") return { ok: false, code: "not_allowed", message: "A manager installs updates" };
  if (process.platform !== "win32") return { ok: false, code: "unexpected", message: "Updates install on Windows" };
  try {
    const check = await updateCheck();
    if (check.kind === "none") return { ok: true, value: null };
    if (check.kind === "not_eligible") throw new BusinessError("update_not_eligible", "Released after the support plan ended");
    const installer = await downloadInstaller(check.manifest, app.getPath("temp"));
    if (current && !remote) current.backupBeforeUpdate(check.manifest.version);
    runInstaller(installer);
    setTimeout(() => app.quit(), 500);
    return { ok: true, value: null };
  } catch (error) {
    return failure(error);
  }
});

/** E-invoice setup and sending happen on the PC that holds the file, by a manager. */
function etaManager(): Business | null {
  return current && !remote && current.currentUser()?.role === "manager" ? current : null;
}

ipcMain.handle(CHANNELS.etaCertificates, () => listCertificates().catch(() => []));

ipcMain.handle(CHANNELS.saveEtaSettings, (_event, input: EtaSettingsInput) => {
  const business = etaManager();
  if (!business) return { ok: false, code: "restore_needs_manager", message: "Only a manager on the PC that holds the file sets up e-invoicing" };
  const secret = input.clientSecret?.trim();
  const settings: EtaSettingsInput = { ...input };
  delete settings.clientSecret;
  if (secret) {
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, code: "unexpected", message: "This PC can't seal the client secret" };
    settings.clientSecret = safeStorage.encryptString(secret).toString("base64");
  }
  return attempt(() => {
    business.setEtaSettings(settings);
    return null;
  });
});

ipcMain.handle(CHANNELS.sendEtaNow, async () => {
  if (!etaManager()) return { ok: false, code: "restore_needs_manager", message: "Only a manager on the PC that holds the file sends e-invoices" };
  try {
    return { ok: true, value: await etaCycle() };
  } catch (error) {
    return failure(error);
  }
});

ipcMain.handle(CHANNELS.cancelEta, async (_event, kind: EtaKind, documentId: number, reason: string) => {
  const link = etaManager() ? etaLink() : null;
  if (!link || !file) return { ok: false, code: "eta_not_enabled", message: "E-invoicing is off here" };
  try {
    await cancelDocument(file.etaBooks(), link.client, kind, documentId, reason);
    return { ok: true, value: null };
  } catch (error) {
    return failure(error);
  }
});

function preferencesPath(): string {
  return join(app.getPath("userData"), "preferences.json");
}

function cleanPrinter(value: unknown): PrinterSettings {
  if (typeof value !== "object" || value === null) return NO_PRINTER;
  const p = value as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  const flag = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  if (p["kind"] === "windows") {
    return { kind: "windows", deviceName: text(p["deviceName"]), autoPrint: flag(p["autoPrint"], true), footer: text(p["footer"]) };
  }
  if (p["kind"] === "network") {
    const port = Number(p["port"]);
    return {
      kind: "network",
      host: text(p["host"]).trim(),
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 9100,
      openDrawer: flag(p["openDrawer"], true),
      autoPrint: flag(p["autoPrint"], true),
      footer: text(p["footer"]),
    };
  }
  return NO_PRINTER;
}

const language = (v: unknown) => (v === "en" ? "en" : "ar");

function readPreferences(): Preferences {
  try {
    const saved = JSON.parse(readFileSync(preferencesPath(), "utf8")) as Partial<Preferences>;
    return {
      theme: saved.theme && THEMES.includes(saved.theme) ? saved.theme : "calm",
      printer: cleanPrinter(saved.printer),
      screenLanguage: language(saved.screenLanguage),
      documentLanguage: language(saved.documentLanguage),
      digits: saved.digits === "arabic" ? "arabic" : "western",
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

/** Prints and PDFs follow this PC's document language and digit style. */
function documentPreferences(): "ar" | "en" {
  const { documentLanguage, digits } = readPreferences();
  setDigitStyle(digits);
  return documentLanguage;
}

ipcMain.handle(CHANNELS.preferences, () => readPreferences());
ipcMain.handle(CHANNELS.setPreferences, (_event, changes: Partial<Preferences>) => {
  const next = { ...readPreferences() };
  if (changes.theme && THEMES.includes(changes.theme)) next.theme = changes.theme;
  if (changes.printer) next.printer = cleanPrinter(changes.printer);
  if (changes.screenLanguage) next.screenLanguage = language(changes.screenLanguage);
  if (changes.documentLanguage) next.documentLanguage = language(changes.documentLanguage);
  if (changes.digits) next.digits = changes.digits === "arabic" ? "arabic" : "western";
  writeFileSync(preferencesPath(), JSON.stringify(next));
});

ipcMain.handle(CHANNELS.printers, () => listPrinters());

ipcMain.handle(CHANNELS.print, async (_event, request: PrintRequest): Promise<Result<null>> => {
  const printer = readPreferences().printer;
  const footer = printer.kind === "none" ? "" : printer.footer;
  const lang = documentPreferences();
  let document;
  try {
    const settings = await need<BusinessSettings>("settings");
    const qr = async (kind: "sale" | "return", number: number) => {
      const link = await need<string | null>("etaReceiptQr", kind, number);
      return link ? { qr: link } : {};
    };
    if (request.kind === "sale")
      document = {
        ...saleDocument(await need<Receipt>("findReceipt", request.number), settings, { footer, copy: request.copy }, lang),
        ...(await qr("sale", request.number)),
      };
    else if (request.kind === "return")
      document = {
        ...returnDocument(await need<SaleReturn>("findReturn", request.number), settings, { footer, copy: request.copy }, lang),
        ...(await qr("return", request.number)),
      };
    else if (request.kind === "z") document = zReportDocument(await need<ZReport>("zReport", request.shiftId), settings, lang);
    else document = testDocument(settings, footer, lang);
  } catch (error) {
    if (error instanceof Failed) return error.result;
    throw error;
  }
  if (printer.kind === "none") return { ok: false, code: "printer_not_set", message: "No receipt printer is set up" };
  try {
    await printHtml(documentHtml(document), printer, { openDrawer: request.kind === "sale" && request.openDrawer });
    return { ok: true, value: null };
  } catch (error) {
    console.error(error);
    return { ok: false, code: "printer_failed", message: String(error) };
  }
});

ipcMain.handle(CHANNELS.exportExcel, async (_event, table: ReportTable): Promise<Result<{ saved: string | null }>> => {
  const name = `${table.title} ${table.meta.map((m) => m.value).join(" ")}`.replace(/[\\/:*?"<>|]/g, "-");
  const options = { defaultPath: `${name}.xlsx`, filters: [{ name: "Excel", extensions: ["xlsx"] }] };
  const choice = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
  if (choice.canceled || !choice.filePath) return { ok: true, value: { saved: null } };
  writeFileSync(choice.filePath, xlsx(reportSheet(table)));
  return { ok: true, value: { saved: choice.filePath } };
});

ipcMain.handle(CHANNELS.saveImportTemplate, async (_event, lang: "ar" | "en"): Promise<Result<{ saved: string | null }>> => {
  const options = {
    defaultPath: lang === "ar" ? "نموذج استيراد الأصناف والأرصدة.xlsx" : "Items and balances import template.xlsx",
    filters: [{ name: "Excel", extensions: ["xlsx"] }],
  };
  const choice = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
  if (choice.canceled || !choice.filePath) return { ok: true, value: { saved: null } };
  writeFileSync(choice.filePath, importTemplate(lang));
  return { ok: true, value: { saved: choice.filePath } };
});

ipcMain.handle(CHANNELS.openSpreadsheet, async (): Promise<Result<{ name: string; sheets: { name: string; rows: string[][] }[] } | null>> => {
  const options = { properties: ["openFile" as const], filters: [{ name: "Excel / CSV", extensions: ["xlsx", "csv"] }] };
  const choice = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  const path = choice.filePaths[0];
  if (choice.canceled || !path) return { ok: true, value: null };
  try {
    const bytes = new Uint8Array(readFileSync(path));
    const name = basename(path);
    const sheets = /\.csv$/i.test(path)
      ? [{ name, rows: parseCsv(decodeCsv(bytes)) }]
      : readXlsx(bytes, (data) => new Uint8Array(inflateRawSync(data)));
    return { ok: true, value: { name, sheets } };
  } catch (error) {
    console.error(error);
    return { ok: false, code: "spreadsheet_unreadable", message: String(error) };
  }
});

ipcMain.handle(CHANNELS.fileStatus, () =>
  localPath && file && !remote ? { path: localPath, syncFolder: syncFolder(localPath), openElsewhere } : null,
);

ipcMain.handle(CHANNELS.chooseFolder, async () => {
  const options = { properties: ["openDirectory" as const, "createDirectory" as const] };
  const choice = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  return choice.canceled ? null : (choice.filePaths[0] ?? null);
});

ipcMain.handle(CHANNELS.restoreBackup, async (_event, given: string | null) => {
  const business = current;
  if (!business || remote || !localPath || business.currentUser()?.role !== "manager") {
    return { ok: false, code: "restore_needs_manager", message: "Only a manager on the PC that holds the file can restore" };
  }
  let backup = given;
  if (!backup) {
    const options = { properties: ["openFile" as const], filters: [FILE_FILTER] };
    const choice = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (choice.canceled || !choice.filePaths[0]) return { ok: true, value: null };
    backup = choice.filePaths[0];
  }
  const chosen = backup;
  const path = localPath;
  return attempt(() => {
    void stopServing();
    const restored = business.restore(chosen);
    // The old handles are closed by the restore; the restored file opens signed out.
    file = null;
    current = null;
    return switchTo(restored, path);
  });
});

ipcMain.handle(CHANNELS.printA4, async (_event, request: A4Request): Promise<Result<{ saved: string | null }>> => {
  let page: { html: string; name: string };
  const lang = documentPreferences();
  try {
    const settings = await need<BusinessSettings>("settings");
    const customer = async (id: number) => (await need<Customer[]>("customers")).find((c) => c.id === id)!;
    const named = (doc: A4Document, number: number | string) => ({ html: a4Html(doc), name: `${doc.title} ${number}` });
    if (request.kind === "invoice") {
      const invoice = await need<SalesInvoice>("findSalesInvoice", request.number);
      page = named(invoiceA4(invoice, settings, await customer(invoice.customerId), lang), invoice.number);
    } else if (request.kind === "creditNote") {
      const note = await need<CreditNote>("findCreditNote", request.number);
      page = named(creditNoteA4(note, settings, await customer(note.customerId), lang), note.number);
    } else if (request.kind === "deliveryNote") {
      const invoice = await need<SalesInvoice>("findSalesInvoice", request.number);
      page = named(deliveryNoteA4(invoice, settings, await customer(invoice.customerId), lang), invoice.number);
    } else if (request.kind === "quotation") {
      const quotation = await need<Quotation>("findQuotation", request.number, new Date().toLocaleDateString("en-CA"));
      page = named(quotationA4(quotation, settings, await customer(quotation.customerId), lang), quotation.number);
    } else if (request.kind === "report") {
      page = { html: a4Html(reportA4(request.table, settings)), name: `${request.table.title} ${request.table.meta.map((m) => m.value).join(" ")}` };
    } else {
      const st = await need<Statement>("statement", request.party, request.id, request.from, request.to);
      const party =
        request.party === "customer"
          ? (await need<Customer[]>("customers")).find((c) => c.id === request.id)!
          : (await need<Supplier[]>("suppliers")).find((x) => x.id === request.id)!;
      const details = { kind: request.party, address: "address" in party ? party.address : "", taxRegistrationNumber: party.taxRegistrationNumber };
      page = named(statementA4(st, settings, details, lang), `${st.name} ${st.to}`);
    }
  } catch (error) {
    if (error instanceof Failed) return error.result;
    throw error;
  }
  try {
    return { ok: true, value: { saved: await printA4(page.html, request.output, page.name, window) } };
  } catch (error) {
    console.error(error);
    return { ok: false, code: "printer_failed", message: String(error) };
  }
});

// Server mode (ADR 0002)

type NetworkFile = {
  /** Certificate fingerprints pinned on first connect, by "host:port". */
  knownServers: Record<string, string>;
  lastServer: FoundServer | null;
  /** The file this PC serves whenever it is open, and on which port. */
  serve: { path: string; port: number } | null;
};

function networkPath(): string {
  return join(app.getPath("userData"), "network.json");
}

function readNetwork(): NetworkFile {
  try {
    const saved = JSON.parse(readFileSync(networkPath(), "utf8")) as Partial<NetworkFile>;
    return { knownServers: saved.knownServers ?? {}, lastServer: saved.lastServer ?? null, serve: saved.serve ?? null };
  } catch {
    return { knownServers: {}, lastServer: null, serve: null };
  }
}

function writeNetwork(changes: Partial<NetworkFile>): void {
  writeFileSync(networkPath(), JSON.stringify({ ...readNetwork(), ...changes }));
}

function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i): i is NonNullable<typeof i> => !!i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
}

function status(): ServerStatus {
  if (!serving) return { serving: false, port: readNetwork().serve?.port ?? DEFAULT_PORT, fingerprint: "", addresses: lanAddresses(), clients: 0 };
  return {
    serving: true,
    port: serving.server.port,
    fingerprint: shortFingerprint(serving.server.fingerprint),
    addresses: lanAddresses(),
    clients: serving.server.clients(),
  };
}

async function startServing(port: number): Promise<void> {
  if (!file) throw new BusinessError("sign_in_required", "No business is open");
  await stopServing();
  const identity = await loadOrCreateIdentity(join(app.getPath("userData"), "server"));
  const server = await startServer(file, identity, { port });
  serving = { server, stopAdvertising: advertise(file.settings().name, server.port) };
}

async function stopServing(): Promise<void> {
  const running = serving;
  serving = null;
  if (!running) return;
  running.stopAdvertising();
  await running.server.close();
}

ipcMain.handle(CHANNELS.discoverServers, () => discover());
ipcMain.handle(CHANNELS.lastServer, () => readNetwork().lastServer);
ipcMain.handle(CHANNELS.serverStatus, () => status());

ipcMain.handle(CHANNELS.connection, (): Connection => {
  if (remote) return { mode: "client", host: remote.host, port: remote.port, name: remote.hello.settings.name };
  if (file && localPath) return { mode: "local", path: localPath };
  return { mode: "none" };
});

ipcMain.handle(CHANNELS.connectServer, async (_event, host: string, port: number): Promise<Result<BusinessSettings>> => {
  const key = `${host}:${port}`;
  const network = readNetwork();
  let connected: RemoteBusiness;
  try {
    connected = await RemoteBusiness.connect(host, port, network.knownServers[key] ?? null);
  } catch (error) {
    if (error instanceof ConnectError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: "server_unreachable", message: String(error) };
  }
  await stopServing();
  remote?.close();
  unlock();
  file?.close();
  file = null;
  current = null;
  localPath = null;
  remote = connected;
  const settings = connected.hello.settings;
  writeNetwork({ knownServers: { ...network.knownServers, [key]: connected.fingerprint }, lastServer: { name: settings.name, host, port } });
  return { ok: true, value: settings };
});

ipcMain.handle(CHANNELS.setServing, async (_event, on: boolean, port: number): Promise<Result<ServerStatus>> => {
  if (!file || !localPath || current?.currentUser()?.role !== "manager") {
    return { ok: false, code: "not_allowed", message: "Only a manager on the PC that holds the file can serve it" };
  }
  const chosen = Number.isInteger(port) && port > 1023 && port < 65536 ? port : DEFAULT_PORT;
  try {
    if (on) await startServing(chosen);
    else await stopServing();
  } catch (error) {
    const busy = (error as NodeJS.ErrnoException).code === "EADDRINUSE";
    return { ok: false, code: busy ? "server_port_busy" : "unexpected", message: String(error) };
  }
  writeNetwork({ serve: on ? { path: localPath, port: chosen } : null });
  return { ok: true, value: status() };
});

function createWindow(): void {
  window = new BrowserWindow({
    width: 1366,
    height: 768,
    minWidth: 1024,
    minHeight: 640,
    title: "Manager+",
    backgroundColor: "#F4F6F9",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.mjs"),
      contextIsolation: true,
      sandbox: false,
    },
  });
  if (process.env["ELECTRON_RENDERER_URL"]) {
    void window.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }
}

void app
  .whenReady()
  .then(() => loadLicensing().catch((error) => console.error("Reading the licence failed", error)))
  .then(createWindow)
  .then(() => setTimeout(() => void updateCheck().catch(() => null), 15_000));
app.on("window-all-closed", () => {
  void stopServing();
  remote?.close();
  unlock();
  file?.close();
  app.quit();
});
