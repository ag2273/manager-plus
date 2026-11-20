import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Business, type BusinessSettings } from "../core/business";
import { BusinessError } from "../core/errors";
import { CHANNELS, type Result } from "../shared/api";

const FILE_FILTER = { name: "Manager+ business", extensions: ["mplus"] };
const MAX_RECENT = 8;

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
  current?.close();
  current = business;
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

ipcMain.handle(CHANNELS.createBusiness, async (_event, settings: BusinessSettings) => {
  const target = await dialog.showSaveDialog(window!, {
    defaultPath: `${settings.name || "business"}.mplus`,
    filters: [FILE_FILTER],
  });
  if (target.canceled || !target.filePath) return { ok: true, value: null };
  const path = target.filePath;
  return attempt(() => switchTo(Business.create(path, settings), path));
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
  current?.close();
  app.quit();
});
