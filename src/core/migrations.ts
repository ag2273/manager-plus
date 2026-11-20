import type Database from "better-sqlite3";
import { RETAIL_CHART_OF_ACCOUNTS } from "./chart-of-accounts";

type Migration = { version: number; up: (db: Database.Database) => void };

/** Forward-only schema migrations. Never edit a released migration; add a new one. */
export const migrations: readonly Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE business_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          name TEXT NOT NULL,
          address TEXT NOT NULL,
          tax_registration_number TEXT NOT NULL,
          vat_registered INTEGER NOT NULL CHECK (vat_registered IN (0, 1)),
          fiscal_year_start_month INTEGER NOT NULL CHECK (fiscal_year_start_month BETWEEN 1 AND 12)
        ) STRICT;
      `);
    },
  },
  {
    version: 2,
    up: (db) => {
      db.exec(`
        CREATE TABLE accounts (
          id INTEGER PRIMARY KEY,
          code TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense')),
          role TEXT UNIQUE,
          active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
        ) STRICT;

        CREATE TABLE journal_entries (
          id INTEGER PRIMARY KEY,
          date TEXT NOT NULL,
          memo TEXT NOT NULL,
          kind TEXT NOT NULL
        ) STRICT;

        CREATE TABLE ledger_lines (
          id INTEGER PRIMARY KEY,
          entry_id INTEGER NOT NULL REFERENCES journal_entries (id),
          account_id INTEGER NOT NULL REFERENCES accounts (id),
          debit INTEGER NOT NULL CHECK (debit >= 0),
          credit INTEGER NOT NULL CHECK (credit >= 0),
          memo TEXT NOT NULL DEFAULT '',
          CHECK ((debit = 0) <> (credit = 0))
        ) STRICT;

        CREATE INDEX ledger_lines_by_account ON ledger_lines (account_id);
        CREATE INDEX journal_entries_by_date ON journal_entries (date);
      `);
      const insert = db.prepare("INSERT INTO accounts (code, name, type, role) VALUES (?, ?, ?, ?)");
      for (const a of RETAIL_CHART_OF_ACCOUNTS) insert.run(a.code, a.name, a.type, a.role ?? null);
    },
  },
  {
    version: 3,
    up: (db) => {
      db.exec(`
        CREATE TABLE tax_codes (
          id INTEGER PRIMARY KEY,
          kind TEXT NOT NULL UNIQUE CHECK (kind IN ('standard', 'zero_rated', 'exempt')),
          name TEXT NOT NULL
        ) STRICT;

        -- Rates in basis points (1400 = 14%), each in force from its date until the next one.
        CREATE TABLE tax_rates (
          tax_code_id INTEGER NOT NULL REFERENCES tax_codes (id),
          effective_from TEXT NOT NULL,
          rate INTEGER NOT NULL CHECK (rate BETWEEN 0 AND 10000),
          PRIMARY KEY (tax_code_id, effective_from)
        ) STRICT;

        CREATE TABLE items (
          id INTEGER PRIMARY KEY,
          name_ar TEXT NOT NULL,
          name_en TEXT NOT NULL DEFAULT '',
          code TEXT UNIQUE,
          tax_code_id INTEGER NOT NULL REFERENCES tax_codes (id),
          egs_code TEXT NOT NULL DEFAULT '',
          active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
        ) STRICT;

        -- Every item has one base unit (size 1000 = one base unit) and at most one pack unit.
        CREATE TABLE item_units (
          id INTEGER PRIMARY KEY,
          item_id INTEGER NOT NULL REFERENCES items (id),
          kind TEXT NOT NULL CHECK (kind IN ('base', 'pack')),
          name TEXT NOT NULL,
          size INTEGER NOT NULL CHECK (size > 0),
          barcode TEXT UNIQUE,
          sale_price INTEGER NOT NULL CHECK (sale_price >= 0),
          UNIQUE (item_id, kind),
          CHECK (kind = 'pack' OR size = 1000)
        ) STRICT;
      `);
      const code = db.prepare("INSERT INTO tax_codes (kind, name) VALUES (?, ?)");
      const rate = db.prepare("INSERT INTO tax_rates (tax_code_id, effective_from, rate) VALUES (?, ?, ?)");
      const standard = Number(code.run("standard", "ضريبة قيمة مضافة 14%").lastInsertRowid);
      // VAT Law 67/2016: 13% from 8 September 2016, 14% from 1 July 2017.
      rate.run(standard, "2016-09-08", 1300);
      rate.run(standard, "2017-07-01", 1400);
      for (const [kind, name] of [["zero_rated", "خاضع بنسبة صفر"], ["exempt", "معفى"]] as const) {
        rate.run(Number(code.run(kind, name).lastInsertRowid), "2016-09-08", 0);
      }
    },
  },
  {
    version: 4,
    up: (db) => {
      db.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          role TEXT NOT NULL CHECK (role IN ('manager', 'accountant', 'cashier', 'storekeeper')),
          password_hash TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
        ) STRICT;

        -- Append-only record of every command that changed the books: who, when, what.
        CREATE TABLE audit_log (
          id INTEGER PRIMARY KEY,
          at TEXT NOT NULL,
          user_id INTEGER NOT NULL REFERENCES users (id),
          action TEXT NOT NULL,
          entity_id INTEGER,
          detail TEXT NOT NULL
        ) STRICT;

        CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
          BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
        CREATE TRIGGER audit_log_no_removal BEFORE DELETE ON audit_log
          BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
      `);
    },
  },
];

export const LATEST_SCHEMA_VERSION = migrations.at(-1)?.version ?? 0;

/** Applies every migration newer than the file's schema version, all in one transaction. */
export function migrate(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  const pending = migrations.filter((m) => m.version > current);
  if (pending.length === 0) return;
  db.transaction(() => {
    for (const migration of pending) migration.up(db);
    db.pragma(`user_version = ${LATEST_SCHEMA_VERSION}`);
  })();
}
