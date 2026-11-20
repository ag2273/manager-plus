import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
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
  type Result,
} from "../shared/api";
import { documentHtml, returnDocument, saleDocument, testDocument } from "../shared/receipt";
import { listPrinters, printHtml } from "./printer";

const FILE_FILTER = { name: "Manager+ business", extensions: ["mplus"] };
const MAX_RECENT = 8;

/** The open business file, signed out, and the same business acting for the signed-in user. */
let file: Business | null = null;
let current: Business | null = null;
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
  file?.close();
  file = business;
  current = business.currentUser() ? business : null;
  rememberRecent(path);
  return business.settings();
}

function attempt<T>(work: () => T): Result<T> {
  try {
    return { ok: true, value: work() };
  } catch (error) {
    if (error instanceof BusinessError) return { ok: false, code: error.code, message: error.message };
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

ipcMain.handle(CHANNELS.signIn, (_event, credentials: Credentials) => {
  if (!file) return { ok: false, code: "unexpected", message: "No business is open" };
  const opened = file;
  return attempt(() => {
    current = opened.signIn(credentials.name, credentials.password);
    return current.currentUser();
  });
});

ipcMain.handle(CHANNELS.signOut, () => {
  current = null;
});

ipcMain.handle(CHANNELS.call, (_event, method: BusinessMethod, args: unknown[]) => {
  if (!BUSINESS_METHODS.includes(method) || !Array.isArray(args)) {
    return { ok: false, code: "unexpected", message: `Not a business method: ${String(method)}` };
  }
  if (!current) return { ok: false, code: "sign_in_required", message: "Sign in first" };
  const business = current;
  return attempt(() => (business[method] as (...a: unknown[]) => unknown).apply(business, args));
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
  const business = current;
  const document = attempt(() => {
    if (!business) throw new BusinessError("sign_in_required", "Sign in first");
    const settings = business.settings();
    const footer = printer.kind === "none" ? "" : printer.footer;
    if (request.kind === "sale") return saleDocument(business.findReceipt(request.number), settings, { footer, copy: request.copy });
    if (request.kind === "return") return returnDocument(business.findReturn(request.number), settings, { footer, copy: request.copy });
    return testDocument(settings, footer);
  });
  if (!document.ok) return document;
  if (printer.kind === "none") return { ok: false, code: "printer_not_set", message: "No receipt printer is set up" };
  try {
    await printHtml(documentHtml(document.value), printer, { openDrawer: request.kind === "sale" && request.openDrawer });
    return { ok: true, value: null };
  } catch (error) {
    console.error(error);
    return { ok: false, code: "printer_failed", message: String(error) };
  }
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
  file?.close();
  app.quit();
});
