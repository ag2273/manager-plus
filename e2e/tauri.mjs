// The Tauri app end to end (#73 to #81): create a business, post a journal entry, stock an item,
// buy from a supplier and sell at the till through the Rust core, and see them on the Accounts, Items, Warehouses, Purchases and Till screens. Needs tauri-driver and the platform's WebDriver
// (WebKitWebDriver on Linux, msedgedriver on Windows). Run after `npx tauri build --debug --no-bundle`:
//   node e2e/tauri.mjs target/debug/manager-plus      (Linux: under xvfb-run -a)
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, click, fill, launch, run, sleep, until } from "./driver.mjs";

const app = process.argv[2] ?? "target/debug/manager-plus";
const dir = mkdtempSync(join(tmpdir(), "mplus-tauri-"));

const file = join(dir, "shop.mplus");
// The app answers its save dialog with this path, and keeps its data in a fresh folder.
// Files the screens save land in `saved`, and the import's open dialog answers with the template saved there.
const saved = join(dir, "saved");
mkdirSync(saved);
const template = join(saved, "نموذج استيراد الأصناف والأرصدة.xlsx");
const launched = await launch(app, {
  MANAGER_PLUS_E2E_SAVE_AS: file,
  MANAGER_PLUS_E2E_SAVE_DIR: saved,
  MANAGER_PLUS_E2E_OPEN: template,
  XDG_DATA_HOME: join(dir, "data"),
});
const { session } = launched;
try {
  console.log("the ledger, items, stock, purchases and the till on Tauri");

  await until(session, "the welcome screen", fill, "اسم النشاط", "بقالة النور");
  check(await run(session, () => document.documentElement.dir === "rtl"), "the screens run right to left");
  await run(session, fill, "اسمك", "أيمن");
  await run(session, fill, "كلمة السر", "strong-password-1");
  await run(session, click, "إنشاء النشاط");
  await until(session, "the main menu", () => document.querySelector("nav.sidebar"));
  check(readFileSync(file).subarray(0, 15).toString() === "SQLite format 3", "the Rust core wrote the business file");
  await until(session, "the first steps", () => document.querySelector("#setup-title")?.textContent === "خطوات البداية");
  check(true, "a new business opens on its first steps");
  const closed = await run(session, () => window.api.call("openShift", [0]));
  check(closed.ok === false && closed.code === "setup_not_finished", "the till stays closed until the opening balances are confirmed");

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
  await run(session, click, "الرئيسية");
  await until(session, "the confirm button", () => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "تأكيد أرصدة أول المدة وبدء العمل");
    return b && !b.disabled;
  });
  await run(session, click, "تأكيد أرصدة أول المدة وبدء العمل");
  await until(session, "the setup's end", () => document.querySelector("[role=status]")?.textContent.includes("اكتملت خطوات البداية"));
  check(true, "confirming the opening balances opens sales and purchases");
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

  // A serialised item bought with its serials: they show on the old invoice and in the item's list (#97, notes 5-6).
  const serialised = await run(session, async () => {
    const tax = (await window.api.call("taxCodes", [])).value[0].id;
    const item = await window.api.call("addItem", [{ nameAr: "لابتوب ديل", baseUnit: "قطعة", salePrice: 2000000, taxCodeId: tax }]);
    await window.api.call("setItemSerials", [item.value, { serialised: true, warrantyMonths: 12 }]);
    const supplier = (await window.api.call("suppliers", [])).value[0].id;
    const main = (await window.api.call("warehouses", [])).value[0].id;
    const invoice = await window.api.call("postPurchaseInvoice", [
      { date: "2026-02-02", supplierId: supplier, warehouseId: main, reference: "INV-78", lines: [{ itemId: item.value, unit: "base", quantity: 2000, unitPrice: 1500000, serials: ["DL-001", "DL-002"] }] },
    ]);
    const units = await window.api.call("itemSerials", [item.value]);
    return invoice.ok && units.ok && units.value.map((u) => u.serial).join() === "DL-001,DL-002";
  });
  check(serialised === true, "a serialised purchase lists its units in stock through the Rust core");
  await run(session, click, "الفواتير السابقة");
  await until(session, "the old invoices", () => document.body.textContent.includes("INV-78"));
  await run(session, () => {
    const row = [...document.querySelectorAll("tr")].find((r) => r.textContent.includes("INV-78"));
    [...row.querySelectorAll("button")].find((b) => b.textContent.trim() === "التفاصيل").click();
  });
  await until(session, "the invoice's serials", () => document.querySelector("table[aria-label='التفاصيل']")?.textContent.includes("DL-002"));
  check(true, "an old purchase invoice shows the serials received on it");
  await run(session, click, "الأصناف والمخزون");
  await until(session, "the item serials list", () => [...document.querySelectorAll("option")].some((o) => o.textContent === "لابتوب ديل"));
  await run(session, () => {
    const select = [...document.querySelectorAll("label")].find((l) => l.textContent.trim().startsWith("اختر الصنف")).querySelector("select");
    const value = [...select.options].find((o) => o.textContent === "لابتوب ديل").value;
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), "value").set.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await until(session, "the units in stock", () => document.querySelector("[aria-label='سيريالات الصنف في المخزن']")?.textContent.includes("DL-001"));
  check(true, "the Items screen lists a serialised item's units in stock with their warehouse");

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

  // A tax invoice to a customer, on the Sales invoices screen.
  const invoiced = await run(session, async () => {
    const customer = await window.api.call("addCustomer", [{ name: "شركة الأمل للتجارة", phone: "", taxRegistrationNumber: "987654321" }]);
    const item = (await window.api.call("items", [{ search: "راوتر" }])).value[0].id;
    const main = (await window.api.call("warehouses", [])).value[0].id;
    const invoice = await window.api.call("postSalesInvoice", [
      { date: "2026-02-10", customerId: customer.value, warehouseId: main, reference: "PO-15", notes: "", lines: [{ itemId: item, unit: "base", quantity: 1000, unitPrice: 120000 }] },
    ]);
    const balance = await window.api.call("customerBalance", [customer.value]);
    return invoice.ok && balance.value === 136800;
  });
  check(invoiced === true, "a sales invoice posts through the Rust core, VAT on top");
  await run(session, click, "فواتير البيع");
  await until(session, "the invoices screen", () => document.body.textContent.includes("شركة الأمل للتجارة"));
  check(true, "the Sales invoices screen lists the invoice");

  // The customer pays part of it into the bank; the books, the aging and the Money screen agree.
  const settled = await run(session, async () => {
    const customer = (await window.api.call("customers", [])).value.find((c) => c.name === "شركة الأمل للتجارة").id;
    const bank = (await window.api.call("accounts", [])).value.find((a) => a.role === "bank");
    const paid = await window.api.call("receiveCustomerPayment", [
      { date: "2026-02-15", partyId: customer, accountId: bank.id, amount: 36800, reference: "شيك 1" },
    ]);
    const aging = (await window.api.call("aging", ["customer", "2026-03-01"])).value;
    const money = (await window.api.call("moneyAccounts", ["2026-12-31"])).value.find((a) => a.id === bank.id);
    return paid.ok && aging.balance === 100000 && money.balance === 36800 ? bank.name : null;
  });
  check(typeof settled === "string", "a customer payment posts through the Rust core and shows in the aging");
  await run(session, click, "الخزينة والبنوك");
  await until(session, "the money screen", (name) => document.body.textContent.includes(name), settled);
  check(true, "the Money screen lists the bank account");

  // An item sheet from Excel or CSV, checked and then imported with its opening stock.
  const imported = await run(session, async () => {
    const warehouseId = (await window.api.call("warehouses", [])).value[0].id;
    const sheets = [{ name: "الأصناف", rows: [["اسم الصنف بالعربية", "الوحدة", "سعر البيع شامل الضريبة", "الكمية الافتتاحية", "تكلفة الوحدة"], ["كابل شبكة", "متر", "11.40", "100", "5.25"]] }];
    const check = await window.api.call("checkImport", [{ date: "2026-01-01", warehouseId, sheets }]);
    const done = await window.api.call("importData", [{ date: "2026-01-01", warehouseId, sheets }]);
    const cable = (await window.api.call("items", [{ search: "كابل شبكة" }])).value[0];
    return check.ok && check.value.problems.length === 0 && done.ok && done.value.stockValue === 52500 && cable?.salePrice === 1140;
  });
  check(imported === true, "an item sheet imports through the Rust core with its opening stock");

  // Reports and the VAT return read the books through the Rust core.
  const reported = await run(session, async () => {
    const pnl = (await window.api.call("profitAndLoss", ["2026-01-01", "2026-12-31"])).value;
    const bs = (await window.api.call("balanceSheet", ["2026-12-31"])).value;
    const vat = await window.api.call("vatReturn", ["2026-01-01", "2026-12-31"]);
    return pnl.totalIncome > 0 && bs.totalAssets === bs.totalLiabilitiesAndEquity && vat.ok && vat.value.outputVat > 0;
  });
  check(reported === true, "profit and loss, the balance sheet and the VAT return come from the Rust core");
  await run(session, click, "التقارير");
  await until(session, "the reports screen", () => document.body.textContent.includes("الأرباح والخسائر"));
  await run(session, click, "إقرار القيمة المضافة");
  await until(session, "the VAT return", () => document.body.textContent.includes("ضريبة"));
  check(true, "the Reports screen shows the VAT return");

  // The receipt, drawn by WebView2 and sent as ESC/POS to a network printer (here a socket of ours).
  const printer = await new Promise((listening) => {
    const got = [];
    const server = createServer((socket) => socket.on("data", (d) => got.push(d)));
    server.listen(0, "127.0.0.1", () => listening({ server, got, port: server.address().port }));
  });
  const printed = await run(
    session,
    async (port) => {
      await window.api.setPreferences({ printer: { kind: "network", host: "127.0.0.1", port, openDrawer: true, autoPrint: false, footer: "شكرًا لزيارتكم" } });
      return window.api.print({ kind: "sale", number: 1, copy: true, openDrawer: true });
    },
    printer.port,
  );
  await sleep(300);
  printer.server.close();
  const job = Buffer.concat(printer.got);
  const raster = job.indexOf(Buffer.from([0x1d, 0x76, 0x30, 0x00]));
  const rowBytes = job[raster + 4] + job[raster + 5] * 256;
  const inked = job.subarray(raster + 8, job.length - 9).filter((b) => b !== 0).length;
  if (process.env.RECEIPT_OUT) writeFileSync(process.env.RECEIPT_OUT, job);
  check(printed.ok === true && job[0] === 0x1b && job[1] === 0x40 && rowBytes === 72, "the receipt prints as an 80 mm ESC/POS raster");
  check(inked > 2000, `the receipt has ink on it (${inked} dark bytes)`);
  check(job.subarray(-5).equals(Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa])), "a cash sale opens the drawer");

  // The lock beside the file, a backup into a folder, and restoring it (which signs out).
  check(existsSync(`${file}.lock`), "the open file has a lock beside it");
  const backups = join(dir, "backups");
  mkdirSync(backups);
  const backedUp = await run(
    session,
    async (folder) => {
      await window.api.call("setBackupFolder", [folder]);
      const made = await window.api.call("backupNow", []);
      const status = (await window.api.call("backupStatus", [])).value;
      const restored = await window.api.restoreBackup(made.value.path);
      const after = await window.api.call("backupStatus", []);
      return made.ok && status.backups.length === 1 && restored.ok && after.code === "sign_in_required";
    },
    backups,
  );
  check(backedUp === true, "a backup is made and restored through the Rust core, signed out after");
  // The backup, the file just before the restore, and the restored file's own daily backup (its copy had none yet).
  check(readdirSync(backups).length === 3, "the file as it was before the restore is backed up too");

  // Serving the file to other PCs (ADR 0002): a manager turns it on, and a TLS client gets the business's hello.
  const port = 47_000 + Math.floor(Math.random() * 1_000);
  const serving = await run(
    session,
    async (port) => {
      const signed = await window.api.signIn({ name: "أيمن", password: "strong-password-1" });
      const on = await window.api.setServing(true, port);
      return { signed: signed.ok, on };
    },
    port,
  );
  check(serving.signed && serving.on.ok && serving.on.value.serving && serving.on.value.port === port, "a manager turns on serving the file");
  check(/^([0-9A-F]{2}:){7}[0-9A-F]{2}$/.test(serving.on.value.fingerprint), "the server shows a short certificate fingerprint");
  const hello = await new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => socket.write(`${JSON.stringify({ id: 1, op: "hello" })}\n`));
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      text += chunk;
      if (text.includes("\n")) {
        socket.destroy();
        resolve(JSON.parse(text));
      }
    });
    socket.on("error", reject);
  });
  check(hello.ok && hello.value.app === "manager-plus" && hello.value.settings.name === "بقالة النور", "another PC reaches the Rust server over TLS");

  // E-invoicing is optional and off: its screens' queries answer from the Rust core.
  const eta = await run(session, async () => {
    const settings = await window.api.call("etaSettings", []);
    const documents = await window.api.call("etaDocuments", []);
    const receipts = await window.api.call("etaReceipts", []);
    return settings.ok && settings.value.enabled === false && documents.ok && receipts.ok && receipts.value.length === 0;
  });
  check(eta === true, "the e-invoice settings and queues come from the Rust core");

  // The trial starts with the first business file; the licence server is out of reach here.
  const licence = await run(session, async () => {
    const status = await window.api.licenceStatus();
    const activated = await window.api.activateLicence("abcd-efgh");
    const update = await window.api.checkUpdate(false);
    const cached = await window.api.checkUpdate(true);
    return { status, activated, update, cached };
  });
  check(licence.status?.mode === "trial" && licence.status.daysLeft === 14, "the 14-day trial runs from the new business file");
  check(licence.activated.ok === false && licence.activated.code === "licence_unreachable", "activating without the licence server says it can't be reached");
  check(licence.update.ok === false && licence.update.code === "update_unreachable", "checking for updates without the server says so");
  check(licence.cached.ok && licence.cached.value.kind === "none", "the update banner has nothing to offer");
  check(existsSync(join(dir, "data", "app.managerplus.desktop", "licence.json")), "the licence state is kept in the app's data folder");

  // Excel files, the import template and A4 pages (#97, note 4): the screens build them, the Rust side saves and opens them.
  const files = await run(session, async () => {
    const table = { lang: "ar", title: "تقرير", meta: [{ label: "في", value: "2026-11-23" }], columns: [{ label: "المبلغ", kind: "money" }], rows: [[150000]], totals: [] };
    const excel = await window.api.exportExcel(table);
    const template = await window.api.saveImportTemplate("ar");
    const opened = await window.api.openSpreadsheet();
    const pdf = await window.api.printA4({ kind: "report", table, output: "pdf" });
    return { excel, template, opened, pdf };
  });
  check(files.excel.ok && files.excel.value.saved === join(saved, "تقرير 2026-11-23.xlsx"), "a report exports to Excel where the user saves it");
  check(readFileSync(files.excel.value.saved).subarray(0, 2).toString() === "PK", "the Excel file is a workbook");
  check(files.template.ok && files.template.value.saved === template && existsSync(template), "the import template saves");
  check(
    files.opened.ok && files.opened.value.name === "نموذج استيراد الأصناف والأرصدة.xlsx" && files.opened.value.sheets[0].name === "الأصناف",
    "the import reads a workbook back, inflating it in the webview",
  );
  check(files.pdf.ok === false && files.pdf.code === "pdf_failed", "an A4 PDF, made by WebView2 on Windows, explains itself elsewhere");

  const rss = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${await appPid()}/status`, "utf8"))?.[1] ?? 0);
  if (rss) console.log(`  app RAM (resident): ${Math.round(rss / 1024)} MB`);
} finally {
  await launched.close();
}

/** The app's process id (Linux), for its memory. */
async function appPid() {
  const { execSync } = await import("node:child_process");
  return execSync(`pgrep -n -f '${app.replace(/'/g, "")}$'`).toString().trim();
}
