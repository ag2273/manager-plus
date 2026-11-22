// Makes the fixtures the Rust core is checked against, with the TypeScript core:
//   npx esbuild crates/core/tests/fixtures/make.ts --bundle --platform=node --format=esm --packages=external --outfile=make.mjs
//   node make.mjs crates/core/tests/fixtures && rm make.mjs
import { writeFileSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { Business } from "../../../../src/core/business";
import { PERMISSIONS } from "../../../../src/core/users";
import { BUSINESS_METHODS } from "../../../../src/shared/api";
const out = process.argv[2];
const roles = Object.fromEntries([...new Set([...BUSINESS_METHODS, ...Object.keys(PERMISSIONS)])].sort().map((m) => [m, PERMISSIONS[m] ?? ["manager"]]));
writeFileSync(`${out}/permissions.json`, JSON.stringify(roles, null, 1) + "\n");
const path = `${out}/made-by-typescript.mplus`;
rmSync(path, { force: true });
const shop = { name: "بقالة النور", address: "الدقي", taxRegistrationNumber: "123456789", vatRegistered: true, fiscalYearStartMonth: 7 };
const b = Business.create(path, shop, { name: "أيمن", password: "كلمة سر قوية" });
const id = (code: string) => b.accounts().find((a) => a.code === code)!.id;
b.addUser({ name: "سارة", role: "cashier", password: "123456" });
b.postJournalEntry({ date: "2026-11-01", memo: "إيجار نوفمبر", lines: [{ accountId: id("6100"), debit: 500_000 }, { accountId: id("1110"), credit: 500_000 }] });
b.close();
const db = new Database(path);
db.pragma("journal_mode = DELETE");
const schema = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();
db.close();
writeFileSync(`${out}/schema.json`, JSON.stringify(schema, null, 1) + "\n");
