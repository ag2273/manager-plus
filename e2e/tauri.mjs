// The Tauri app end to end (#73 to #76): create a business, post a journal entry, stock an item,
// buy from a supplier and sell at the till through the Rust core, and see them on the Accounts, Items, Warehouses, Purchases and Till screens. Needs tauri-driver and the platform's WebDriver
// (WebKitWebDriver on Linux, msedgedriver on Windows). Run after `npx tauri build --debug --no-bundle`:
//   node e2e/tauri.mjs target/debug/manager-plus      (Linux: under xvfb-run -a)
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const app = process.argv[2] ?? "target/debug/manager-plus";
const dir = mkdtempSync(join(tmpdir(), "mplus-tauri-"));
const DRIVER = "http://127.0.0.1:4444";

function check(ok, what) {
  if (!ok) throw new Error(`Failed: ${what}`);
  console.log(`  ok  ${what}`);
}

async function wd(method, path, body) {
  const response = await fetch(`${DRIVER}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${JSON.stringify(data.value)}`);
  return data.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDriver() {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${DRIVER}/status`);
      return;
    } catch {
      await sleep(200);
    }
  }
  throw new Error("tauri-driver did not start");
}

/** Runs `fn` in the page with `args`, as WebDriver's execute/sync (async functions are awaited). */
const run = (session, fn, ...args) =>
  wd("POST", `/session/${session}/execute/async`, {
    script: `const done = arguments[arguments.length - 1]; Promise.resolve((${fn})(...Array.from(arguments).slice(0, -1))).then(done, (e) => done({ error: String(e) }));`,
    args,
  });

/** Waits until `fn` returns something truthy in the page. */
async function until(session, what, fn, ...args) {
  for (let i = 0; i < 100; i++) {
    const value = await run(session, fn, ...args);
    if (value && !value.error) return value;
    await sleep(150);
  }
  throw new Error(`Timed out: ${what}`);
}

// In the page: fill a field by its label, and click a button by its text, the way a person would.
const fill = (label, value) => {
  const l = [...document.querySelectorAll("label")].find((x) => x.textContent.trim().startsWith(label));
  const input = l && (l.control ?? l.querySelector("input, select, textarea"));
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value").set;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
};
const click = (text) => {
  const b = [...document.querySelectorAll("button, [role=tab], a")].find((x) => x.textContent.trim() === text);
  if (!b) return false;
  b.click();
  return true;
};

const file = join(dir, "shop.mplus");
// The app answers its save dialog with this path; it and a fresh data folder reach it through tauri-driver.
const env = { ...process.env, MANAGER_PLUS_E2E_SAVE_AS: file, XDG_DATA_HOME: join(dir, "data") };
const driver = spawn("tauri-driver", [], { stdio: "inherit", env });
let session;
try {
  await waitForDriver();
  session = (
    await wd("POST", "/session", {
      capabilities: { alwaysMatch: { "tauri:options": { application: app }, "webkitgtk:browserOptions": { args: [] } } },
    })
  ).sessionId;
  console.log("the ledger, items, stock, purchases and the till on Tauri");

  await until(session, "the welcome screen", fill, "اسم النشاط", "بقالة النور");
  check(await run(session, () => document.documentElement.dir === "rtl"), "the screens run right to left");
  await run(session, fill, "اسمك", "أيمن");
  await run(session, fill, "كلمة السر", "strong-password-1");
  await run(session, click, "إنشاء النشاط");
  await until(session, "the main menu", () => document.querySelector("nav.sidebar"));
  check(readFileSync(file).subarray(0, 15).toString() === "SQLite format 3", "the Rust core wrote the business file");

  const entry = await run(session, async () => {
    const accounts = await window.api.call("accounts", []);
    const id = (code) => accounts.value.find((a) => a.code === code).id;
    return window.api.call("postJournalEntry", [
      { date: "2026-11-01", memo: "إيجار نوفمبر", lines: [{ accountId: id("6100"), debit: 500000 }, { accountId: id("1110"), credit: 500000 }] },
    ]);
  });
  check(entry.ok === true && entry.value > 0, "a journal entry posts through the Rust core");

  await run(session, click, "الحسابات");
  await until(session, "the chart of accounts", () => document.body.textContent.includes("الخزينة الرئيسية"));
  check(true, "the Accounts screen lists the chart");
  await run(session, click, "ميزان المراجعة");
  await until(session, "the trial balance", () => /5[,٬.]?000/.test(document.body.textContent) || document.body.textContent.includes("٥٬٠٠٠"));
  check(true, "the trial balance shows the entry");

  // Items and stock, from the Rust core to the screens.
  const stocked = await run(session, async () => {
    const tax = (await window.api.call("taxCodes", [])).value[0].id;
    const item = await window.api.call("addItem", [{ nameAr: "راوتر واي فاي", baseUnit: "قطعة", barcode: "6221", salePrice: 150000, taxCodeId: tax }]);
    const main = (await window.api.call("warehouses", [])).value[0].id;
    const stock = await window.api.call("postOpeningStock", ["2026-01-01", main, [{ itemId: item.value, quantity: 3000, unitCost: 120000 }]]);
    await window.api.call("setItemMinimum", [item.value, 5000]);
    const scanned = await window.api.call("findByBarcode", ["6221"]);
    return stock.ok && scanned.ok && scanned.value.itemId === item.value;
  });
  check(stocked === true, "an item, its opening stock and its minimum go through the Rust core");
  await run(session, click, "الأصناف والمخزون");
  await until(session, "the item list", () => document.body.textContent.includes("راوتر واي فاي"));
  check(true, "the Items screen lists the item");
  await run(session, click, "المخازن والتحويلات");
  await until(session, "the warehouses", () => document.body.textContent.includes("المخزن الرئيسي"));
  await run(session, click, "النواقص");
  await until(session, "the low-stock list", () => document.body.textContent.includes("راوتر واي فاي"));
  check(true, "the low-stock tab lists the item under its minimum");

  // A supplier's invoice, through the Rust core and on the Purchases screen.
  const bought = await run(session, async () => {
    const supplier = await window.api.call("addSupplier", [{ name: "شركة الشبكات المتحدة", phone: "", taxRegistrationNumber: "" }]);
    const item = (await window.api.call("items", [{ search: "راوتر" }])).value[0].id;
    const main = (await window.api.call("warehouses", [])).value[0].id;
    const invoice = await window.api.call("postPurchaseInvoice", [
      { date: "2026-02-01", supplierId: supplier.value, warehouseId: main, reference: "INV-77", lines: [{ itemId: item, unit: "base", quantity: 2000, unitPrice: 100000 }] },
    ]);
    const balance = await window.api.call("supplierBalance", [supplier.value]);
    return invoice.ok && balance.value === 228000;
  });
  check(bought === true, "a purchase invoice posts through the Rust core, VAT included");
  await run(session, click, "المشتريات والموردين");
  await until(session, "the purchases screen", () => document.body.textContent.includes("شركة الشبكات المتحدة"));
  check(true, "the Purchases screen lists the supplier");

  // The till: open a shift, scan the item, take cash, and close with a Z report.
  await run(session, click, "شاشة البيع");
  await until(session, "the open-shift form", fill, "النقدية في الدرج عند البداية", "0");
  await run(session, () => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "فتح وردية").click());
  await until(session, "the till", () => document.querySelector(".till-search"));
  await run(session, fill, "امسح الباركود", "6221");
  await run(session, () => document.querySelector(".till-search").form.requestSubmit());
  await until(session, "the scanned line", () => document.querySelector("table.lines")?.textContent.includes("راوتر واي فاي"));
  await until(session, "the price", () => !document.querySelector(".till-complete")?.disabled);
  await run(session, click, "إتمام البيع (Enter)");
  await until(session, "the sale is done", () => document.body.textContent.includes("تم البيع · إيصال رقم 1"));
  check(true, "a cash sale at the till posts through the Rust core");
  const z = await run(session, async () => {
    const shift = (await window.api.call("currentShift", [])).value;
    const report = (await window.api.call("zReport", [shift.id])).value;
    return report.receipts === 1 && report.sales.total === 150000 && report.expectedCash === 150000;
  });
  check(z === true, "the Z report counts the sale and the cash in the drawer");

  const rss = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${await appPid()}/status`, "utf8"))?.[1] ?? 0);
  if (rss) console.log(`  app RAM (resident): ${Math.round(rss / 1024)} MB`);
} finally {
  if (session) await wd("DELETE", `/session/${session}`).catch(() => {});
  driver.kill();
}

/** The app's process id (Linux), for its memory. */
async function appPid() {
  const { execSync } = await import("node:child_process");
  return execSync(`pgrep -n -f '${app.replace(/'/g, "")}$'`).toString().trim();
}
