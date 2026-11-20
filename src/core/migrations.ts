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
  {
    version: 5,
    up: (db) => {
      db.exec(`
        CREATE TABLE warehouses (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
        ) STRICT;

        CREATE TABLE stock_transfers (
          id INTEGER PRIMARY KEY,
          date TEXT NOT NULL,
          from_warehouse_id INTEGER NOT NULL REFERENCES warehouses (id),
          to_warehouse_id INTEGER NOT NULL REFERENCES warehouses (id),
          memo TEXT NOT NULL,
          CHECK (from_warehouse_id <> to_warehouse_id)
        ) STRICT;

        -- Every change in stock. Quantity in thousandths of the base unit (signed);
        -- value in piastres (signed): what the movement adds to or takes from stock at cost.
        CREATE TABLE stock_movements (
          id INTEGER PRIMARY KEY,
          date TEXT NOT NULL,
          item_id INTEGER NOT NULL REFERENCES items (id),
          warehouse_id INTEGER NOT NULL REFERENCES warehouses (id),
          quantity INTEGER NOT NULL CHECK (quantity <> 0),
          value INTEGER NOT NULL,
          source TEXT NOT NULL,
          source_id INTEGER NOT NULL
        ) STRICT;

        CREATE INDEX stock_movements_by_item ON stock_movements (item_id, warehouse_id);
        CREATE INDEX stock_movements_by_source ON stock_movements (source, source_id);
      `);
      db.prepare("INSERT INTO warehouses (name) VALUES (?)").run("المخزن الرئيسي");
    },
  },
  {
    version: 6,
    up: (db) => {
      db.exec(`
        CREATE TABLE suppliers (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          phone TEXT NOT NULL DEFAULT '',
          tax_registration_number TEXT NOT NULL DEFAULT '',
          active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
        ) STRICT;

        -- The supplier a payables line belongs to, so each supplier's balance comes from the ledger.
        ALTER TABLE ledger_lines ADD COLUMN supplier_id INTEGER REFERENCES suppliers (id);
        CREATE INDEX ledger_lines_by_supplier ON ledger_lines (supplier_id) WHERE supplier_id IS NOT NULL;

        CREATE TABLE purchase_invoices (
          id INTEGER PRIMARY KEY,
          date TEXT NOT NULL,
          supplier_id INTEGER NOT NULL REFERENCES suppliers (id),
          warehouse_id INTEGER NOT NULL REFERENCES warehouses (id),
          reference TEXT NOT NULL,
          entry_id INTEGER NOT NULL REFERENCES journal_entries (id),
          user_id INTEGER NOT NULL REFERENCES users (id)
        ) STRICT;

        -- Quantity in thousandths of the line's unit; prices and amounts in piastres, VAT-exclusive.
        CREATE TABLE purchase_invoice_lines (
          id INTEGER PRIMARY KEY,
          invoice_id INTEGER NOT NULL REFERENCES purchase_invoices (id),
          item_id INTEGER NOT NULL REFERENCES items (id),
          unit TEXT NOT NULL CHECK (unit IN ('base', 'pack')),
          quantity INTEGER NOT NULL CHECK (quantity > 0),
          unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
          net INTEGER NOT NULL,
          vat_rate INTEGER NOT NULL,
          vat INTEGER NOT NULL
        ) STRICT;
      `);
    },
  },
  {
    version: 7,
    up: (db) => {
      db.exec(`
        -- Till receipts. "number" is the gap-free receipt sequence. The ETA fields stay
        -- empty until e-receipts are sent (optional, per business).
        CREATE TABLE sales_receipts (
          id INTEGER PRIMARY KEY,
          number INTEGER NOT NULL UNIQUE,
          date TEXT NOT NULL,
          at TEXT NOT NULL,
          warehouse_id INTEGER NOT NULL REFERENCES warehouses (id),
          entry_id INTEGER NOT NULL REFERENCES journal_entries (id),
          user_id INTEGER NOT NULL REFERENCES users (id),
          cash_received INTEGER NOT NULL CHECK (cash_received >= 0),
          eta_uuid TEXT NOT NULL DEFAULT '',
          eta_previous_uuid TEXT NOT NULL DEFAULT '',
          eta_status TEXT NOT NULL DEFAULT ''
        ) STRICT;

        -- Quantity in thousandths of the line's unit; unit price and gross are VAT-inclusive.
        CREATE TABLE sales_receipt_lines (
          id INTEGER PRIMARY KEY,
          receipt_id INTEGER NOT NULL REFERENCES sales_receipts (id),
          item_id INTEGER NOT NULL REFERENCES items (id),
          unit TEXT NOT NULL CHECK (unit IN ('base', 'pack')),
          quantity INTEGER NOT NULL CHECK (quantity > 0),
          unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
          gross INTEGER NOT NULL,
          net INTEGER NOT NULL,
          vat_rate INTEGER NOT NULL,
          vat INTEGER NOT NULL,
          cost INTEGER NOT NULL
        ) STRICT;

        CREATE INDEX sales_receipts_by_date ON sales_receipts (date);
      `);
    },
  },
  {
    version: 8,
    up: (db) => {
      db.exec(`
        -- A cashier's shift at the till: opened with a float, closed with a cash count.
        CREATE TABLE shifts (
          id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users (id),
          opened_at TEXT NOT NULL,
          opening_float INTEGER NOT NULL CHECK (opening_float >= 0),
          closed_at TEXT,
          counted_cash INTEGER,
          close_entry_id INTEGER REFERENCES journal_entries (id),
          CHECK ((closed_at IS NULL) = (counted_cash IS NULL))
        ) STRICT;
        CREATE UNIQUE INDEX shifts_one_open_per_user ON shifts (user_id) WHERE closed_at IS NULL;

        ALTER TABLE sales_receipts ADD COLUMN shift_id INTEGER REFERENCES shifts (id);
        CREATE INDEX sales_receipts_by_shift ON sales_receipts (shift_id);

        -- Cash paid into or out of the drawer during a shift.
        CREATE TABLE cash_movements (
          id INTEGER PRIMARY KEY,
          shift_id INTEGER NOT NULL REFERENCES shifts (id),
          at TEXT NOT NULL,
          direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
          amount INTEGER NOT NULL CHECK (amount > 0),
          account_id INTEGER NOT NULL REFERENCES accounts (id),
          reason TEXT NOT NULL,
          entry_id INTEGER NOT NULL REFERENCES journal_entries (id)
        ) STRICT;
      `);
    },
  },
  {
    version: 9,
    up: (db) => {
      db.exec(`
        CREATE TABLE customers (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          phone TEXT NOT NULL DEFAULT '',
          tax_registration_number TEXT NOT NULL DEFAULT '',
          active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
        ) STRICT;

        -- The customer a receivables line belongs to, so each customer's balance comes from the ledger.
        ALTER TABLE ledger_lines ADD COLUMN customer_id INTEGER REFERENCES customers (id);
        CREATE INDEX ledger_lines_by_customer ON ledger_lines (customer_id) WHERE customer_id IS NOT NULL;

        ALTER TABLE sales_receipts ADD COLUMN customer_id INTEGER REFERENCES customers (id);

        -- What each tender paid towards a receipt; cash is after change. The unpaid rest is on credit.
        CREATE TABLE sales_receipt_payments (
          id INTEGER PRIMARY KEY,
          receipt_id INTEGER NOT NULL REFERENCES sales_receipts (id),
          method TEXT NOT NULL CHECK (method IN ('cash', 'card', 'wallet')),
          amount INTEGER NOT NULL CHECK (amount > 0)
        ) STRICT;
        CREATE INDEX sales_receipt_payments_by_receipt ON sales_receipt_payments (receipt_id);

        -- Receipts made before tenders were recorded were all paid in cash.
        INSERT INTO sales_receipt_payments (receipt_id, method, amount)
          SELECT r.id, 'cash', SUM(l.gross) FROM sales_receipts r JOIN sales_receipt_lines l ON l.receipt_id = r.id
           GROUP BY r.id HAVING SUM(l.gross) > 0;
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
