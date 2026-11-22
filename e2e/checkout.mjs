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
    total: "١١٤٫٠٠",
    zTitle: "تقرير Z",
    counted: "النقدية المعدودة في الدرج",
    noPrinter: "لم يتم إعداد طابعة",
    print: "اطبع التقرير",
    trial: "نسخة تجريبية: باقي 14 أيام",
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
    total: "114.00",
    zTitle: "Z report",
    counted: "Cash counted in the drawer",
    noPrinter: "No receipt printer",
    print: "Print the report",
    trial: "Trial: 14 days left",
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
    await run(session, fill, t.you, "Ayman");
    await run(session, fill, t.password, "strong-password-1");
    await run(session, clickIn, "form", t.create);
    await until(session, "the main menu", () => document.querySelector("nav"));
    await until(session, "the trial banner", (trial) => document.querySelector("[role=note]")?.textContent.includes(trial), t.trial);
    check(true, "a new install runs the 14-day trial");

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
