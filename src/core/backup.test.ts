import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { Business } from "./business";
import { syncFolder, takeLock } from "./file-lock";

const manager = { name: "أيمن", password: "كلمة سر قوية" };
const shop = { name: "شركة النور للكمبيوتر", address: "", taxRegistrationNumber: "", vatRegistered: true, fiscalYearStartMonth: 1 };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mplus-backup-"));
  dirs.push(dir);
  return dir;
}

/** A business file with a year of trading: purchases, till sales, invoices, credit notes and expenses. */
function tradingFile(path: string, days = 120): Business {
  const business = Business.create(path, shop, manager);
  const main = business.warehouses()[0]!.id;
  const code = (kind: string) => business.taxCodes().find((c) => c.kind === kind)!.id;
  const account = (role: string) => business.accounts().find((a) => a.role === role)!.id;
  const items = Array.from({ length: 20 }, (_, i) =>
    business.addItem({ nameAr: `صنف ${i}`, baseUnit: "قطعة", salePrice: 11_400 + i * 1_140, taxCodeId: code(i % 5 === 0 ? "exempt" : "standard") }),
  );
  const supplier = business.addSupplier({ name: "مورد", phone: "", taxRegistrationNumber: "" });
  const customer = business.addCustomer({ name: "شركة الأمل", phone: "", taxRegistrationNumber: "" });
  const rent = business.accounts().find((a) => a.name === "الإيجار")!.id;
  business.openShift(0);
  for (let d = 0; d < days; d++) {
    const date = new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10);
    const item = items[d % items.length]!;
    if (d % 7 === 0) {
      business.postPurchaseInvoice({ date, supplierId: supplier, warehouseId: main, reference: "", lines: items.map((itemId) => ({ itemId, unit: "base" as const, quantity: 10_000, unitPrice: 5_000 + d * 10 })) });
    }
    business.postSale({ date, warehouseId: main, lines: [{ itemId: item, unit: "base", quantity: 1_000 }], payments: [{ method: "cash", amount: 100_000 }] });
    if (d % 3 === 0) {
      const invoice = business.postSalesInvoice({ date, customerId: customer, warehouseId: main, reference: "", notes: "", lines: [{ itemId: item, unit: "base", quantity: 2_000, unitPrice: 10_000 }] });
      if (d % 9 === 0) {
        const lineId = business.findSalesInvoice(invoice.number).lines[0]!.lineId;
        business.postCreditNote({ date, invoiceId: invoice.id, reason: "مرتجع", lines: [{ lineId, quantity: 1_000 }] });
      }
    }
    if (d % 30 === 0) business.recordExpense({ date, expenseAccountId: rent, amount: 500_000, vat: 0, paidFrom: { accountId: account("main_cash") }, memo: "" });
  }
  return business;
}

/** Every report over the period, as one value to compare. */
function reports(business: Business) {
  return {
    trial: business.trialBalance("2026-12-31"),
    pnl: business.profitAndLoss("2026-01-01", "2026-12-31"),
    balance: business.balanceSheet("2026-12-31"),
    byItem: business.salesByItem("2026-01-01", "2026-12-31"),
    byDay: business.salesByDay("2026-01-01", "2026-12-31"),
    byMethod: business.salesByPaymentMethod("2026-01-01", "2026-12-31"),
    stock: business.stockAt("2026-12-31"),
    vat: business.vatReturn("2026-01-01", "2026-12-31"),
  };
}

/** Takes a current file back to schema 18, as the previous release left it. */
function downgradeTo18(path: string): void {
  const db = new Database(path);
  db.exec(`
    DROP TABLE eta_documents; DROP TABLE eta_settings;
    ALTER TABLE customers DROP COLUMN governate;
    ALTER TABLE customers DROP COLUMN region_city;
    ALTER TABLE customers DROP COLUMN building_number;
    DROP TABLE stock_count_lines; DROP TABLE stock_counts; DROP TABLE write_off_lines; DROP TABLE write_offs;
    ALTER TABLE items DROP COLUMN min_quantity;
    ALTER TABLE business_settings DROP COLUMN backup_folder;
    ALTER TABLE business_settings DROP COLUMN last_backup_at;
    PRAGMA user_version = 18;
  `);
  db.close();
}

describe("backups", () => {
  test("backing up needs a folder, copies the open file and keeps the newest thirty", () => {
    const dir = tempDir();
    const folder = join(dir, "USB");
    mkdirSync(folder);
    const business = tradingFile(join(dir, "shop.mplus"), 10);
    expect(() => business.backupNow()).toThrow(expect.objectContaining({ code: "backup_folder_required" }));
    expect(() => business.setBackupFolder(join(dir, "missing"))).toThrow(expect.objectContaining({ code: "backup_folder_invalid" }));
    business.setBackupFolder(folder);
    writeFileSync(join(folder, "notes.txt"), "not a backup");

    const first = business.backupNow();
    expect(first.name).toMatch(/^shop نسخة احتياطية \d{4}-\d{2}-\d{2} \d{6}\.mplus$/);
    const copy = Business.open(first.path).signIn(manager.name, manager.password);
    expect(reports(copy)).toEqual(reports(business));
    copy.close();

    for (let day = 1; day <= 32; day++) business.scheduledBackup(new Date(Date.UTC(2027, 0, day, 9)));
    const { backups, lastBackupAt } = business.backupStatus();
    expect(backups).toHaveLength(30);
    expect(backups[0]!.at).toBe("2027-02-01T09:00:00Z");
    expect(backups.at(-1)!.at).toBe("2027-01-03T09:00:00Z");
    expect(lastBackupAt).toBe("2027-02-01T09:00:00.000Z");
    expect(existsSync(join(folder, "notes.txt"))).toBe(true);
    business.close();
  });

  test("the daily backup runs once a day, and not at all without a folder", () => {
    const dir = tempDir();
    const business = tradingFile(join(dir, "shop.mplus"), 3);
    expect(business.scheduledBackup(new Date("2027-01-01T08:00:00Z"))).toBeNull();
    business.setBackupFolder(dir);
    expect(business.scheduledBackup(new Date("2027-01-01T08:00:00Z"))).not.toBeNull();
    expect(business.scheduledBackup(new Date("2027-01-01T08:30:00Z"))).toBeNull();
    expect(business.scheduledBackup(new Date("2027-01-02T08:00:00Z"))).not.toBeNull();
    business.close();
  });

  test("restoring backs up the file as it is, then opens the chosen backup signed out", () => {
    const dir = tempDir();
    const path = join(dir, "shop.mplus");
    const business = tradingFile(path, 10);
    business.setBackupFolder(dir);
    const before = reports(business);
    const backup = business.backupNow();
    business.addCustomer({ name: "عميل بعد النسخة", phone: "", taxRegistrationNumber: "" });

    const restored = business.restore(backup.path);
    expect(restored.currentUser()).toBeNull();
    const signedIn = restored.signIn(manager.name, manager.password);
    expect(reports(signedIn)).toEqual(before);
    expect(signedIn.customers().map((c) => c.name)).toEqual(["شركة الأمل"]);
    // The file as it was just before the restore is the newest backup.
    const latest = signedIn.backupStatus().backups[0]!;
    const kept = Business.open(latest.path).signIn(manager.name, manager.password);
    expect(kept.customers().map((c) => c.name)).toContain("عميل بعد النسخة");
    kept.close();

    writeFileSync(join(dir, "junk.mplus"), "junk");
    expect(() => signedIn.restore(join(dir, "junk.mplus"))).toThrow(expect.objectContaining({ code: "not_a_business_file" }));
    signedIn.close();
  });
});

describe("safe upgrades", () => {
  test("opening a file from the previous release backs it up beside itself and keeps every report identical", () => {
    const dir = tempDir();
    const path = join(dir, "shop.mplus");
    const original = tradingFile(path);
    const before = reports(original);
    original.close();
    downgradeTo18(path);

    const upgraded = Business.open(path).signIn(manager.name, manager.password);
    expect(reports(upgraded)).toEqual(before);
    expect(readdirSync(dir)).toContain("shop قبل التحديث 18.mplus");
    upgraded.close();
    // The copy is the file as it was: still at schema 18, so opening it upgrades it too.
    expect(() => Business.check(join(dir, "shop قبل التحديث 18.mplus"))).not.toThrow();
  });

  test("a failed upgrade puts the file back as it was", () => {
    const dir = tempDir();
    const path = join(dir, "shop.mplus");
    const original = tradingFile(path, 20);
    const before = reports(original);
    original.close();
    downgradeTo18(path);
    // Something in the way of the next migration.
    const db = new Database(path);
    db.exec("CREATE TABLE stock_counts (x INTEGER)");
    db.close();

    expect(() => Business.open(path)).toThrow(expect.objectContaining({ code: "migration_failed" }));
    const after = new Database(path);
    expect(after.pragma("user_version", { simple: true })).toBe(18);
    after.exec("DROP TABLE stock_counts");
    after.close();
    const reopened = Business.open(path).signIn(manager.name, manager.password);
    expect(reports(reopened)).toEqual(before);
    reopened.close();
  });
});

describe("the lock file", () => {
  test("another PC's fresh lock is reported; this PC's own or a stale one is taken over", () => {
    const dir = tempDir();
    const path = join(dir, "shop.mplus");
    const now = new Date("2027-01-01T10:00:00Z");
    expect(takeLock(path, { host: "SHOP-PC", pid: 1 }, now)).toBeNull();
    expect(takeLock(path, { host: "OFFICE-PC", pid: 7 }, new Date("2027-01-01T10:05:00Z"))).toEqual({ host: "SHOP-PC", pid: 1, at: now.toISOString() });
    expect(takeLock(path, { host: "OFFICE-PC", pid: 8 }, new Date("2027-01-01T10:06:00Z"))).toBeNull();
    expect(takeLock(path, { host: "SHOP-PC", pid: 2 }, new Date("2027-01-01T11:00:00Z"))).toBeNull();
  });

  test("sync folders are recognised", () => {
    expect(syncFolder("C:\\Users\\Ayman\\OneDrive - Al Nour\\Shop\\shop.mplus")).toBe("OneDrive");
    expect(syncFolder("C:\\Users\\Ayman\\Dropbox\\shop.mplus")).toBe("Dropbox");
    expect(syncFolder("G:\\My Drive\\shop.mplus")).toBe("Google Drive");
    expect(syncFolder("D:\\Accounts\\shop.mplus")).toBeNull();
  });
});
