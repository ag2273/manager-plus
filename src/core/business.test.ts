import { mkdtempSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { Business } from "./business";

const manager = { name: "أيمن", password: "كلمة سر قوية" };

function tempFile(name = "shop.mplus"): string {
  return join(mkdtempSync(join(tmpdir(), "manager-plus-")), name);
}

const shop = {
  name: "بقالة النور",
  address: "12 شارع التحرير، الدقي، الجيزة",
  taxRegistrationNumber: "123456789",
  vatRegistered: true,
  fiscalYearStartMonth: 1,
};

describe("creating a business", () => {
  test("a new business remembers its settings", () => {
    const business = Business.create(":memory:", shop, manager);

    expect(business.settings()).toEqual(shop);
  });
});

describe("opening a business file", () => {
  test("a business saved to a file can be reopened with the same settings", () => {
    const path = tempFile();
    Business.create(path, shop, manager).close();

    const reopened = Business.open(path);

    expect(reopened.settings()).toEqual(shop);
    reopened.close();
  });

  test("a business file can be opened again and again", () => {
    const path = tempFile();
    Business.create(path, shop, manager).close();
    Business.open(path).close();

    const reopened = Business.open(path);

    expect(reopened.settings().name).toBe(shop.name);
    reopened.close();
  });

  test("creating a business never overwrites an existing file", () => {
    const path = tempFile();
    Business.create(path, shop, manager).close();

    expect(() => Business.create(path, { ...shop, name: "Other shop" }, manager)).toThrow(
      expect.objectContaining({ code: "file_exists" }),
    );
    const original = Business.open(path);
    expect(original.settings().name).toBe(shop.name);
    original.close();
  });

  test("a file that isn't a business file is refused", () => {
    const path = tempFile("notes.txt");
    writeFileSync(path, "shopping list: sugar, tea");

    expect(() => Business.open(path)).toThrow(expect.objectContaining({ code: "not_a_business_file" }));
  });

  test("an unrelated database file is refused", () => {
    const path = tempFile("other.db");
    const other = new Database(path);
    other.exec("CREATE TABLE things (id INTEGER)");
    other.close();

    expect(() => Business.open(path)).toThrow(expect.objectContaining({ code: "not_a_business_file" }));
  });

  test("a missing file is reported as missing", () => {
    expect(() => Business.open(tempFile("gone.mplus"))).toThrow(expect.objectContaining({ code: "file_not_found" }));
  });

  test("a file saved by a newer version of the app is refused rather than damaged", () => {
    const path = tempFile();
    Business.create(path, shop, manager).close();
    // Simulate a file written by a future app version.
    const raw = new Database(path);
    raw.pragma("user_version = 999");
    raw.close();

    expect(() => Business.open(path)).toThrow(expect.objectContaining({ code: "made_by_newer_version" }));
  });
});

describe("refusing bad input", () => {
  test("a business needs a name", () => {
    expect(() => Business.create(":memory:", { ...shop, name: "   " }, manager)).toThrow(
      expect.objectContaining({ code: "name_required" }),
    );
  });

  test.each(["12345678", "1234567890", "12345678A"])(
    "a tax registration number must be 9 digits (rejects %s)",
    (taxRegistrationNumber) => {
      expect(() => Business.create(":memory:", { ...shop, taxRegistrationNumber }, manager)).toThrow(
        expect.objectContaining({ code: "tax_registration_number_invalid" }),
      );
    },
  );

  test("the fiscal year must start in a real month", () => {
    expect(() => Business.create(":memory:", { ...shop, fiscalYearStartMonth: 13 }, manager)).toThrow(
      expect.objectContaining({ code: "fiscal_year_start_month_invalid" }),
    );
  });
});

describe("tidying input", () => {
  test("a tax registration number typed in Arabic-Indic digits is stored in Western digits", () => {
    const business = Business.create(":memory:", { ...shop, taxRegistrationNumber: "١٢٣٤٥٦٧٨٩" }, manager);

    expect(business.settings().taxRegistrationNumber).toBe("123456789");
  });

  test("a business can have no tax registration number", () => {
    const business = Business.create(":memory:", { ...shop, taxRegistrationNumber: "", vatRegistered: false }, manager);

    expect(business.settings().taxRegistrationNumber).toBe("");
  });

  test("surrounding spaces are removed from the name and address", () => {
    const business = Business.create(":memory:", { ...shop, name: "  بقالة النور ", address: " الدقي  " }, manager);

    expect(business.settings()).toMatchObject({ name: "بقالة النور", address: "الدقي" });
  });
});
