// A till checkout in the real app, in each screen language: create a business, sell by barcode for cash,
// close the shift and read the Z report. Run after `npm run build`:
//   node e2e/checkout.cjs            (Linux CI: xvfb-run -a node e2e/checkout.cjs)
const { _electron: electron } = require("playwright");
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

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
    sold: /تم البيع/,
    total: "١١٤٫٠٠",
    zTitle: "تقرير Z",
    counted: "النقدية المعدودة في الدرج",
    noPrinter: /لم يتم إعداد طابعة/,
    print: "اطبع التقرير",
    trial: /نسخة تجريبية: باقي 14 أيام/,
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
    sold: /Sold/,
    total: "114.00",
    zTitle: "Z report",
    counted: "Cash counted in the drawer",
    noPrinter: /No receipt printer/,
    print: "Print the report",
    trial: /Trial: 14 days left/,
  },
};

function check(ok, what) {
  if (!ok) throw new Error(`Failed: ${what}`);
  console.log(`  ok  ${what}`);
}

async function journey(lang) {
  const t = LANGUAGES[lang];
  const dir = mkdtempSync(join(tmpdir(), `mplus-e2e-${lang}-`));
  const userData = join(dir, "user-data");
  mkdirSync(userData);
  writeFileSync(join(userData, "preferences.json"), JSON.stringify({ theme: "calm", ...t.prefs }));
  const file = join(dir, "shop.mplus");
  const app = await electron.launch({
    executablePath: require("electron"),
    args: [join(__dirname, ".."), "--no-sandbox", `--user-data-dir=${userData}`],
  });
  try {
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, file);
    const page = await app.firstWindow();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    console.log(`checkout in ${lang}`);

    await page.getByLabel(t.business).fill(lang === "ar" ? "بقالة النور" : "Al Nour Grocery");
    check((await page.evaluate(() => document.documentElement.dir)) === t.dir, `the screens run ${t.dir}`);
    await page.getByLabel(t.you).fill("Ayman");
    await page.getByLabel(t.password, { exact: true }).fill("strong-password-1");
    await page.getByRole("button", { name: t.create }).click();
    await page.getByRole("navigation").waitFor();
    await page.getByRole("note").filter({ hasText: t.trial }).waitFor();
    check(true, "a new install runs the 14-day trial");

    await page.evaluate(async () => {
      const call = (method, args) => window.api.call(method, args).then((r) => r.value);
      const standard = (await call("taxCodes", [])).find((c) => c.kind === "standard").id;
      const item = await call("addItem", [
        { nameAr: "منظف 1 لتر", nameEn: "Cleaner 1 l", baseUnit: "قطعة", barcode: "6221000000035", salePrice: 5_700, taxCodeId: standard },
      ]);
      const supplier = await call("addSupplier", [{ name: "Supplier", phone: "", taxRegistrationNumber: "" }]);
      const warehouse = (await call("warehouses", []))[0].id;
      const date = new Date().toLocaleDateString("en-CA");
      await call("postPurchaseInvoice", [
        {
          date,
          supplierId: supplier,
          warehouseId: warehouse,
          reference: "",
          lines: [{ itemId: item, unit: "base", quantity: 10_000, unitPrice: 4_000 }],
        },
      ]);
    });

    await page.getByRole("navigation").getByRole("button", { name: t.till }).click();
    const keys = page.keyboard;
    await page.getByLabel(t.float).waitFor();
    await keys.type("0");
    await keys.press("Enter");
    await page.locator(".till-search").waitFor();
    for (let i = 0; i < 2; i++) {
      await keys.type("6221000000035");
      await keys.press("Enter");
      await page.waitForTimeout(300);
    }
    const due = await page.locator(".till-total").textContent();
    check(due.includes(t.total), `two scans come to ${t.total}`);
    await keys.press("F12");
    await keys.type(lang === "ar" ? "٢٠٠" : "200");
    await keys.press("Enter");
    await page.waitForTimeout(500);
    check(t.sold.test(await page.getByRole("status").textContent()), "the sale is confirmed");

    await keys.press("F10");
    await page.getByLabel(t.counted).waitFor();
    await keys.type("114");
    await keys.press("Enter");
    await page.waitForTimeout(500);
    check((await page.locator("h1").textContent()).includes(t.zTitle), "the Z report shows");
    await page.getByRole("button", { name: t.print }).click();
    await page.waitForTimeout(300);
    check(t.noPrinter.test(await page.getByRole("alert").textContent()), "printing without a printer explains itself");
    await page.screenshot({ path: join(dir, `z-${lang}.png`) });
    check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  for (const lang of process.argv.slice(2).length ? process.argv.slice(2) : ["ar", "en"]) await journey(lang);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
