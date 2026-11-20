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
