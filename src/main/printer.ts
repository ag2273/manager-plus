import { BrowserWindow, webContents } from "electron";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Socket } from "node:net";
import { type Bitmap, receiptJob } from "../shared/escpos";
import { RECEIPT_WIDTH } from "../shared/receipt";
import type { PrinterSettings } from "../shared/api";

const resolve = createRequire(import.meta.url).resolve;
const NETWORK_TIMEOUT_MS = 5000;

/** The receipt font, embedded so the hidden window draws Arabic the same on every PC. */
function fontCss(): string {
  const faces: string[] = [];
  for (const weight of [400, 600, 700]) {
    try {
      const path = resolve(`@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-arabic-${weight}-normal.woff2`);
      const data = readFileSync(path).toString("base64");
      faces.push(`@font-face { font-family: "IBM Plex Sans Arabic"; font-weight: ${weight}; src: url(data:font/woff2;base64,${data}) format("woff2"); }`);
    } catch {
      // Without the bundled font, Tahoma (on every Windows PC) still draws Arabic.
    }
  }
  return faces.join("\n");
}

let cachedFont: string | null = null;

/** Draws the receipt HTML in a hidden window one receipt wide and hands it to `use`. */
async function withPage<T>(html: string, use: (page: BrowserWindow) => Promise<T>): Promise<T> {
  const page = new BrowserWindow({
    show: false,
    width: RECEIPT_WIDTH,
    height: 800,
    useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true },
  });
  try {
    cachedFont ??= fontCss();
    // Scripts stay blocked for the page itself; the main process still measures it.
    const full = html.replace("<style>", `<meta http-equiv="Content-Security-Policy" content="script-src 'none'"><style>\n${cachedFont}`);
    await page.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(full)}`);
    await page.webContents.executeJavaScript("document.fonts.ready.then(() => true)", true).catch(() => true);
    return await use(page);
  } finally {
    page.destroy();
  }
}

/** The page drawn to a bitmap at its full height. */
async function capture(page: BrowserWindow): Promise<Bitmap> {
  // The body, not the page: the page is never shorter than the window.
  const height = (await page.webContents.executeJavaScript("Math.ceil(document.body.getBoundingClientRect().height)", true)) as number;
  page.setContentSize(RECEIPT_WIDTH, height);
  await page.webContents.executeJavaScript("new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))", true);
  const image = await page.webContents.capturePage({ x: 0, y: 0, width: RECEIPT_WIDTH, height });
  const size = image.getSize();
  return { width: size.width, height: size.height, data: new Uint8Array(image.toBitmap()) };
}

function sendToNetworkPrinter(host: string, port: number, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    socket.setTimeout(NETWORK_TIMEOUT_MS);
    socket.once("timeout", () => socket.destroy(new Error(`Printer at ${host}:${port} did not answer`)));
    socket.once("error", reject);
    socket.connect(port, host, () => {
      socket.end(Buffer.from(bytes), () => resolve());
    });
  });
}

/**
 * Prints one receipt. A network printer gets ESC/POS raster bytes on port 9100, with
 * the drawer kick for cash. A Windows printer prints through its driver, which draws
 * the same page; its drawer opens if the driver is set to "open drawer before printing".
 */
export async function printHtml(html: string, settings: PrinterSettings, options: { openDrawer: boolean }): Promise<void> {
  if (settings.kind === "none") return;
  await withPage(html, async (page) => {
    if (settings.kind === "network") {
      const bitmap = await capture(page);
      await sendToNetworkPrinter(settings.host, settings.port, receiptJob(bitmap, { openDrawer: options.openDrawer && settings.openDrawer }));
      return;
    }
    await new Promise<void>((resolve, reject) => {
      page.webContents.print(
        {
          silent: true,
          deviceName: settings.deviceName,
          printBackground: false,
          margins: { marginType: "none" },
        },
        (ok, reason) => (ok ? resolve() : reject(new Error(reason))),
      );
    });
  });
}

/** Printers installed in Windows, for the setup screen. */
export async function listPrinters(): Promise<string[]> {
  const contents = webContents.getAllWebContents()[0];
  if (!contents) return [];
  return (await contents.getPrintersAsync()).map((p) => p.name);
}
