import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { Business, type BusinessSettings } from "../core/business";
import type { Credentials } from "../core/users";
import { BusinessError } from "../core/errors";
import {
  BUSINESS_METHODS,
  CHANNELS,
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
import { documentHtml, returnDocument, saleDocument, testDocument } from "../shared/receipt";
import { listPrinters, printA4, printHtml } from "./printer";
import { a4Html, creditNoteA4, deliveryNoteA4, invoiceA4, quotationA4, statementA4 } from "../shared/a4";
import { type ReportTable, reportA4, reportSheet } from "../shared/report-tables";
import { xlsx } from "../shared/xlsx";

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
  file?.close();
  file = business;
  localPath = path;
  current = business.currentUser() ? business : null;
  rememberRecent(path);
  const serve = readNetwork().serve;
  if (serve && serve.path === path) void startServing(serve.port).catch((error) => console.error(error));
  return business.settings();
}

function attempt<T>(work: () => T): Result<T> {
  try {
    return { ok: true, value: work() };
  } catch (error) {
    if (error instanceof BusinessError) {
      return { ok: false, code: error.code, message: error.message, ...(error.amount === undefined ? {} : { amount: error.amount }) };
    }
    console.error(error);
    return { ok: false, code: "unexpected", message: String(error) };
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

ipcMain.handle(CHANNELS.call, (_event, method: BusinessMethod, args: unknown[]) => {
  if (!BUSINESS_METHODS.includes(method) || !Array.isArray(args)) {
    return { ok: false, code: "unexpected", message: `Not a business method: ${String(method)}` };
  }
  return call(method, args);
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

function readPreferences(): Preferences {
  try {
    const saved = JSON.parse(readFileSync(preferencesPath(), "utf8")) as Partial<Preferences>;
    return {
      theme: saved.theme && THEMES.includes(saved.theme) ? saved.theme : "calm",
      printer: cleanPrinter(saved.printer),
    };
  } catch {
    return { theme: "calm", printer: NO_PRINTER };
  }
}

ipcMain.handle(CHANNELS.preferences, () => readPreferences());
ipcMain.handle(CHANNELS.setPreferences, (_event, changes: Partial<Preferences>) => {
  const next = { ...readPreferences() };
  if (changes.theme && THEMES.includes(changes.theme)) next.theme = changes.theme;
  if (changes.printer) next.printer = cleanPrinter(changes.printer);
  writeFileSync(preferencesPath(), JSON.stringify(next));
});

ipcMain.handle(CHANNELS.printers, () => listPrinters());

ipcMain.handle(CHANNELS.print, async (_event, request: PrintRequest): Promise<Result<null>> => {
  const printer = readPreferences().printer;
  const footer = printer.kind === "none" ? "" : printer.footer;
  let document;
  try {
    const settings = await need<BusinessSettings>("settings");
    if (request.kind === "sale") document = saleDocument(await need<Receipt>("findReceipt", request.number), settings, { footer, copy: request.copy });
    else if (request.kind === "return") document = returnDocument(await need<SaleReturn>("findReturn", request.number), settings, { footer, copy: request.copy });
    else document = testDocument(settings, footer);
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

ipcMain.handle(CHANNELS.printA4, async (_event, request: A4Request): Promise<Result<{ saved: string | null }>> => {
  let page: { html: string; name: string };
  try {
    const settings = await need<BusinessSettings>("settings");
    if (request.kind === "invoice") {
      const invoice = await need<SalesInvoice>("findSalesInvoice", request.number);
      const customer = (await need<Customer[]>("customers")).find((c) => c.id === invoice.customerId)!;
      page = { html: a4Html(invoiceA4(invoice, settings, customer)), name: `فاتورة ${invoice.number}` };
    } else if (request.kind === "creditNote") {
      const note = await need<CreditNote>("findCreditNote", request.number);
      const customer = (await need<Customer[]>("customers")).find((c) => c.id === note.customerId)!;
      page = { html: a4Html(creditNoteA4(note, settings, customer)), name: `إشعار دائن ${note.number}` };
    } else if (request.kind === "deliveryNote") {
      const invoice = await need<SalesInvoice>("findSalesInvoice", request.number);
      const customer = (await need<Customer[]>("customers")).find((c) => c.id === invoice.customerId)!;
      page = { html: a4Html(deliveryNoteA4(invoice, settings, customer)), name: `إذن تسليم ${invoice.number}` };
    } else if (request.kind === "quotation") {
      const quotation = await need<Quotation>("findQuotation", request.number, new Date().toLocaleDateString("en-CA"));
      const customer = (await need<Customer[]>("customers")).find((c) => c.id === quotation.customerId)!;
      page = { html: a4Html(quotationA4(quotation, settings, customer)), name: `عرض سعر ${quotation.number}` };
    } else if (request.kind === "report") {
      page = { html: a4Html(reportA4(request.table, settings)), name: `${request.table.title} ${request.table.meta.map((m) => m.value).join(" ")}` };
    } else {
      const st = await need<Statement>("statement", request.party, request.id, request.from, request.to);
      const party =
        request.party === "customer"
          ? (await need<Customer[]>("customers")).find((c) => c.id === request.id)!
          : (await need<Supplier[]>("suppliers")).find((x) => x.id === request.id)!;
      const details = { kind: request.party, address: "address" in party ? party.address : "", taxRegistrationNumber: party.taxRegistrationNumber };
      page = { html: a4Html(statementA4(st, settings, details)), name: `كشف حساب ${st.name} ${st.to}` };
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

void app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  void stopServing();
  remote?.close();
  file?.close();
  app.quit();
});
