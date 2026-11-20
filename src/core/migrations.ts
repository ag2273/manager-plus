import type Database from "better-sqlite3";

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
