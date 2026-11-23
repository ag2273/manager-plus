// A till checkout in the built Tauri app, in each screen language: create a business, sell by
// barcode for cash, close the shift and read the Z report. Run after `npx tauri build --debug --no-bundle`:
//   node e2e/checkout.mjs target/debug/manager-plus [ar|en]     (Linux: under xvfb-run -a)
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEY, check, fill, launch, run, sleep, type, until } from "./driver.mjs";

const LANGUAGES = {
  ar: {
    prefs: { screenLanguage: "ar", documentLanguage: "ar", digits: "arabic" },
    dir: "rtl",
    business: "اسم النشاط",
    you: "اسمك",
    password: "كلمة السر",
    create: "إنشاء النشاط",
    till: "شاشة البيع",
    float: "النقدية في الدرج عند البداية (العُهدة)",
    sold: "تم البيع",
    salesTitle: "مبيعات شاشة البيع",
    receipt: "إيصال رقم 1",
    reprint: "إعادة طباعة",
    backToTill: "رجوع لشاشة البيع",
    backToList: "رجوع للقائمة",
    toInvoice: "تحويل إلى فاتورة ضريبية",
    issue: "إصدار الفاتورة بدل الإيصال",
    invoiced: "صدرت الفاتورة رقم 1",
    total: "١١٤٫٠٠",
    zTitle: "تقرير Z",
    counted: "النقدية المعدودة في الدرج",
    noPrinter: "لم يتم إعداد طابعة",
    print: "اطبع التقرير",
    trial: "نسخة تجريبية: باقي 14 أيام",
    fresh: "نشاط جديد ليس له أرصدة سابقة",
    freshYes: "نعم، النشاط جديد",
  },
  en: {
    prefs: { screenLanguage: "en", documentLanguage: "en", digits: "western" },
    dir: "ltr",
    business: "Business name",
    you: "Your name",
    password: "Password",
    create: "Create business",
    till: "Till",
    float: "Cash in the drawer at the start (float)",
    sold: "Sold",
    salesTitle: "Till sales",
    receipt: "Receipt 1",
    reprint: "Print again",
    backToTill: "Back to the till",
    backToList: "Back to the list",
    toInvoice: "Turn into a tax invoice",
    issue: "Issue the invoice in place of the receipt",
    invoiced: "Invoice 1 was issued",
    total: "114.00",
    zTitle: "Z report",
    counted: "Cash counted in the drawer",
    noPrinter: "No receipt printer",
    print: "Print the report",
    trial: "Trial: 14 days left",
    fresh: "A new business with nothing to bring forward",
    freshYes: "Yes, the business is new",
  },
};

const app = process.argv[2] ?? "target/debug/manager-plus";

/** Whether the element matching `selector` has the keyboard, as the till gives it after each step. */
const focused = (selector) => document.activeElement?.matches(selector) ?? false;
const clickIn = (scope, label) => {
  const b = [...document.querySelectorAll(`${scope} button`)].find((x) => x.textContent.trim() === label);
  b?.click();
  return Boolean(b);
};
const labelled = (label) => {
  const l = [...document.querySelectorAll("label")].find((x) => x.textContent.trim().startsWith(label));
  const input = l && (l.control ?? l.querySelector("input"));
  input?.focus();
  return Boolean(input) && document.activeElement === input;
};

async function journey(lang) {
  const t = LANGUAGES[lang];
  const dir = mkdtempSync(join(tmpdir(), `mplus-e2e-${lang}-`));
  const data = join(dir, "data");
  // The app keeps this PC's preferences in its data folder; the journey starts in the language under test.
  mkdirSync(join(data, "app.managerplus.desktop"), { recursive: true });
  writeFileSync(join(data, "app.managerplus.desktop", "preferences.json"), JSON.stringify({ theme: "calm", ...t.prefs }));
  const launched = await launch(app, { MANAGER_PLUS_E2E_SAVE_AS: join(dir, "shop.mplus"), XDG_DATA_HOME: data });
  const { session } = launched;
  try {
    console.log(`checkout in ${lang}`);
    await until(session, "the welcome screen", fill, t.business, lang === "ar" ? "بقالة النور" : "Al Nour Grocery");
    check((await run(session, () => document.documentElement.dir)) === t.dir, `the screens run ${t.dir}`);
    // The welcome screen is drawn again once this PC's preferences arrive, which can wipe what was typed
    // before; so fill and press again until the business opens.
    const create = (t, shop) => {
      if (document.querySelector("nav")) return true;
      const set = (label, value) => {
        const l = [...document.querySelectorAll("label")].find((x) => x.textContent.trim().startsWith(label));
        const input = l && (l.control ?? l.querySelector("input"));
        if (!input) return;
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value").set.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      set(t.business, shop);
      set(t.you, "Ayman");
      set(t.password, "strong-password-1");
      const button = [...document.querySelectorAll("form button")].find((x) => x.textContent.trim() === t.create);
      setTimeout(() => button?.click(), 50);
      return false;
    };
    for (let i = 0; i < 10 && !(await run(session, create, t, lang === "ar" ? "بقالة النور" : "Al Nour Grocery")); i++) await sleep(1000);
    await until(session, "the main menu", () => document.querySelector("nav"));
    await until(session, "the trial banner", (trial) => document.querySelector("[role=note]")?.textContent.includes(trial), t.trial);
    check(true, "a new install runs the 14-day trial");
    // A new shop with nothing to bring forward says so on its first steps, which opens the till.
    await run(session, clickIn, "main", t.fresh);
    await until(session, "the confirmation", clickIn, "main", t.freshYes);
    await until(session, "the first steps to close", () => !document.querySelector("#setup-title"));
    check(true, "a new business with nothing to bring forward starts at once");

    const stocked = await run(session, async () => {
      const call = (method, args) => window.api.call(method, args).then((r) => r.value);
      const standard = (await call("taxCodes", [])).find((c) => c.kind === "standard").id;
      const item = await call("addItem", [
        { nameAr: "منظف 1 لتر", nameEn: "Cleaner 1 l", baseUnit: "قطعة", barcode: "6221000000035", salePrice: 5_700, taxCodeId: standard },
      ]);
      const supplier = await call("addSupplier", [{ name: "Supplier", phone: "", taxRegistrationNumber: "" }]);
      const warehouse = (await call("warehouses", []))[0].id;
      const date = new Date().toLocaleDateString("en-CA");
      const bought = await window.api.call("postPurchaseInvoice", [
        { date, supplierId: supplier, warehouseId: warehouse, reference: "", lines: [{ itemId: item, unit: "base", quantity: 10_000, unitPrice: 4_000 }] },
      ]);
      return bought.ok;
    });
    check(stocked === true, "the item is bought in");

    await run(session, clickIn, "nav", t.till);
    await until(session, "the float field", labelled, t.float);
    await type(session, `0${KEY.Enter}`);
    await until(session, "the till's search, with the keyboard", focused, ".till-search");
    for (let i = 0; i < 2; i++) {
      await type(session, `6221000000035${KEY.Enter}`);
      await sleep(300);
    }
    const due = await until(session, "the total", (total) => document.querySelector(".till-total")?.textContent.includes(total) && true, t.total);
    check(due === true, `two scans come to ${t.total}`);
    await type(session, KEY.F12);
    await sleep(300);
    await type(session, `${lang === "ar" ? "٢٠٠" : "200"}${KEY.Enter}`);
    await until(session, "the sale", (sold) => document.querySelector("[role=status]")?.textContent.includes(sold), t.sold);
    check(true, "the sale is confirmed");

    // The till's sales list: today's receipt, opened in full and printed again.
    await type(session, KEY.F6);
    await until(session, "the sales list", (title) => document.querySelector("h1")?.textContent === title, t.salesTitle);
    await until(session, "the receipt in the list", () => {
      const row = document.querySelector("tr.clickable");
      row?.click();
      return Boolean(row);
    });
    await until(session, "the receipt in full", (title) => document.querySelector("#receipt-title")?.textContent === title, t.receipt);
    check(await run(session, (total) => document.body.textContent.includes(total), t.total), "the list opens the receipt with its total");
    await run(session, clickIn, "section", t.reprint);
    await until(session, "the reprint's answer", (message) => document.querySelector("[role=alert]")?.textContent.includes(message), t.noPrinter);
    check(true, "a receipt prints again from the sales list");

    // A company customer asks for a tax invoice: the receipt is replaced by one (#97, note 7).
    await run(session, () => window.api.call("addCustomer", [{ name: "شركة الأمل للتجارة", phone: "", taxRegistrationNumber: "987654321" }]));
    await run(session, clickIn, "section", t.toInvoice);
    await until(session, "the customer choice", () => {
      const select = document.querySelector("[role=group] select");
      const option = select && [...select.options].find((o) => o.textContent === "شركة الأمل للتجارة");
      if (!option) return false;
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), "value").set.call(select, option.value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    });
    await until(session, "the issue button", (text) => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === text && !b.disabled), t.issue);
    await run(session, clickIn, "section", t.issue);
    await until(session, "the invoice", (text) => document.querySelector("[role=status]")?.textContent.includes(text), t.invoiced);
    const replaced = await run(session, async () => {
      const invoice = (await window.api.call("findSalesInvoice", [1])).value;
      const customer = (await window.api.call("customers", [])).value.find((c) => c.name === "شركة الأمل للتجارة");
      const owed = (await window.api.call("customerBalance", [customer.id])).value;
      return invoice.total === 11400 && invoice.customerId === customer.id && owed === 0;
    });
    check(replaced === true, "the receipt becomes a tax invoice to the customer, already paid");
    await run(session, clickIn, "main", t.backToList);
    await until(session, "the sales list again", (title) => document.querySelector("h1")?.textContent === title, t.salesTitle);
    await run(session, clickIn, "header", t.backToTill);
    await until(session, "the till's search", () => document.querySelector(".till-search"));

    await type(session, KEY.F10);
    await until(session, "the count field", labelled, t.counted);
    await type(session, `114${KEY.Enter}`);
    await until(session, "the Z report", (title) => document.querySelector("h1")?.textContent.includes(title), t.zTitle);
    check(true, "the Z report shows");
    await run(session, clickIn, "main", t.print);
    await until(session, "the printer message", (message) => document.querySelector("[role=alert]")?.textContent.includes(message), t.noPrinter);
    check(true, "printing without a printer explains itself");
  } finally {
    await launched.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const asked = process.argv.slice(3);
for (const lang of asked.length ? asked : ["ar", "en"]) await journey(lang);
