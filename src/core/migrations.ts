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
  {
    version: 10,
    up: (db) => {
      db.exec(`
        -- The line's own discount plus its share of any receipt discount, VAT included.
        ALTER TABLE sales_receipt_lines ADD COLUMN discount INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0);

        -- A cart put aside at the till; not posted and no receipt number until completed.
        CREATE TABLE held_sales (
          id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users (id),
          at TEXT NOT NULL,
          note TEXT NOT NULL,
          cart TEXT NOT NULL
        ) STRICT;
      `);
    },
  },
  {
    version: 11,
    up: (db) => {
      db.exec(`
        -- A return against an original receipt; "number" is its own gap-free sequence.
        CREATE TABLE sales_returns (
          id INTEGER PRIMARY KEY,
          number INTEGER NOT NULL UNIQUE,
          date TEXT NOT NULL,
          at TEXT NOT NULL,
          receipt_id INTEGER NOT NULL REFERENCES sales_receipts (id),
          shift_id INTEGER NOT NULL REFERENCES shifts (id),
          user_id INTEGER NOT NULL REFERENCES users (id),
          entry_id INTEGER NOT NULL REFERENCES journal_entries (id),
          refund TEXT NOT NULL CHECK (refund IN ('cash', 'account')),
          eta_uuid TEXT NOT NULL DEFAULT '',
          eta_status TEXT NOT NULL DEFAULT ''
        ) STRICT;

        -- What came back of a receipt line, at that line's original amount, VAT and cost.
        CREATE TABLE sales_return_lines (
          id INTEGER PRIMARY KEY,
          return_id INTEGER NOT NULL REFERENCES sales_returns (id),
          receipt_line_id INTEGER NOT NULL REFERENCES sales_receipt_lines (id),
          quantity INTEGER NOT NULL CHECK (quantity > 0),
          amount INTEGER NOT NULL,
          net INTEGER NOT NULL,
          vat INTEGER NOT NULL,
          cost INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX sales_return_lines_by_receipt_line ON sales_return_lines (receipt_line_id);
        CREATE INDEX sales_returns_by_shift ON sales_returns (shift_id);
      `);
    },
  },
  {
    version: 12,
    up: (db) => {
      db.exec(`
        ALTER TABLE customers ADD COLUMN address TEXT NOT NULL DEFAULT '';
        ALTER TABLE customers ADD COLUMN price_level TEXT NOT NULL DEFAULT 'retail' CHECK (price_level IN ('retail', 'wholesale'));
        -- NULL is no limit.
        ALTER TABLE customers ADD COLUMN credit_limit INTEGER CHECK (credit_limit IS NULL OR credit_limit >= 0);
        ALTER TABLE suppliers ADD COLUMN currency TEXT NOT NULL DEFAULT 'EGP' CHECK (currency IN ('EGP', 'USD', 'EUR', 'CNY'));

        -- An A4 tax invoice to a customer, on account; "number" is gap-free.
        CREATE TABLE sales_invoices (
          id INTEGER PRIMARY KEY,
          number INTEGER NOT NULL UNIQUE,
          date TEXT NOT NULL,
          customer_id INTEGER NOT NULL REFERENCES customers (id),
          warehouse_id INTEGER NOT NULL REFERENCES warehouses (id),
          reference TEXT NOT NULL,
          notes TEXT NOT NULL,
          entry_id INTEGER NOT NULL REFERENCES journal_entries (id),
          user_id INTEGER NOT NULL REFERENCES users (id),
          eta_uuid TEXT NOT NULL DEFAULT '',
          eta_status TEXT NOT NULL DEFAULT ''
        ) STRICT;

        -- VAT-exclusive: net = quantity × unit price − discount; VAT on net.
        CREATE TABLE sales_invoice_lines (
          id INTEGER PRIMARY KEY,
          invoice_id INTEGER NOT NULL REFERENCES sales_invoices (id),
          item_id INTEGER NOT NULL REFERENCES items (id),
          unit TEXT NOT NULL CHECK (unit IN ('base', 'pack')),
          quantity INTEGER NOT NULL CHECK (quantity > 0),
          unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
          discount INTEGER NOT NULL CHECK (discount >= 0),
          net INTEGER NOT NULL CHECK (net >= 0),
          vat_rate INTEGER NOT NULL,
          vat INTEGER NOT NULL CHECK (vat >= 0),
          cost INTEGER NOT NULL
        ) STRICT;

        -- Goods a customer sent back against an invoice; its own gap-free sequence.
        CREATE TABLE credit_notes (
          id INTEGER PRIMARY KEY,
          number INTEGER NOT NULL UNIQUE,
          date TEXT NOT NULL,
          invoice_id INTEGER NOT NULL REFERENCES sales_invoices (id),
          reason TEXT NOT NULL,
          entry_id INTEGER NOT NULL REFERENCES journal_entries (id),
          user_id INTEGER NOT NULL REFERENCES users (id),
          eta_uuid TEXT NOT NULL DEFAULT '',
          eta_status TEXT NOT NULL DEFAULT ''
        ) STRICT;
        CREATE TABLE credit_note_lines (
          id INTEGER PRIMARY KEY,
          note_id INTEGER NOT NULL REFERENCES credit_notes (id),
          invoice_line_id INTEGER NOT NULL REFERENCES sales_invoice_lines (id),
          quantity INTEGER NOT NULL CHECK (quantity > 0),
          net INTEGER NOT NULL,
          vat INTEGER NOT NULL,
          cost INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX credit_note_lines_by_invoice_line ON credit_note_lines (invoice_line_id);

        -- Goods sent back to a supplier against their invoice.
        CREATE TABLE debit_notes (
          id INTEGER PRIMARY KEY,
          number INTEGER NOT NULL UNIQUE,
          date TEXT NOT NULL,
          purchase_invoice_id INTEGER NOT NULL REFERENCES purchase_invoices (id),
          reason TEXT NOT NULL,
          entry_id INTEGER NOT NULL REFERENCES journal_entries (id),
          user_id INTEGER NOT NULL REFERENCES users (id)
        ) STRICT;
        CREATE TABLE debit_note_lines (
          id INTEGER PRIMARY KEY,
          note_id INTEGER NOT NULL REFERENCES debit_notes (id),
          purchase_line_id INTEGER NOT NULL REFERENCES purchase_invoice_lines (id),
          quantity INTEGER NOT NULL CHECK (quantity > 0),
          net INTEGER NOT NULL,
          vat INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX debit_note_lines_by_purchase_line ON debit_note_lines (purchase_line_id);

        -- Money received from a customer or paid to a supplier; numbered per kind.
        CREATE TABLE payments (
          id INTEGER PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('customer', 'supplier')),
          number INTEGER NOT NULL,
          date TEXT NOT NULL,
          customer_id INTEGER REFERENCES customers (id),
          supplier_id INTEGER REFERENCES suppliers (id),
          account_id INTEGER NOT NULL REFERENCES accounts (id),
          amount INTEGER NOT NULL CHECK (amount > 0),
          reference TEXT NOT NULL,
          entry_id INTEGER NOT NULL REFERENCES journal_entries (id),
          user_id INTEGER NOT NULL REFERENCES users (id),
          UNIQUE (kind, number),
          CHECK ((kind = 'customer') = (customer_id IS NOT NULL) AND (kind = 'supplier') = (supplier_id IS NOT NULL))
        ) STRICT;

        -- The part of a payment that settles a given document, by the document's journal entry.
        CREATE TABLE payment_allocations (
          id INTEGER PRIMARY KEY,
          payment_id INTEGER NOT NULL REFERENCES payments (id),
          entry_id INTEGER NOT NULL REFERENCES journal_entries (id),
          amount INTEGER NOT NULL CHECK (amount > 0)
        ) STRICT;
        CREATE INDEX payment_allocations_by_entry ON payment_allocations (entry_id);
      `);
    },
  },
  {
    version: 13,
    up: (db) => {
      db.exec(`
        -- A serialised item records the serial of every unit on every document.
        ALTER TABLE items ADD COLUMN serialised INTEGER NOT NULL DEFAULT 0 CHECK (serialised IN (0, 1));
        ALTER TABLE items ADD COLUMN warranty_months INTEGER NOT NULL DEFAULT 0 CHECK (warranty_months >= 0);

        CREATE TABLE serials (
          id INTEGER PRIMARY KEY,
          item_id INTEGER NOT NULL REFERENCES items (id),
          serial TEXT NOT NULL,
          UNIQUE (item_id, serial)
        ) STRICT;
        CREATE INDEX serials_by_serial ON serials (serial);

        -- Each unit in (+1) or out (−1) of a warehouse, on the document line that moved it.
        -- Where a serial is, and whether it is in stock, comes only from these rows.
        CREATE TABLE serial_movements (
          id INTEGER PRIMARY KEY,
          serial_id INTEGER NOT NULL REFERENCES serials (id),
          date TEXT NOT NULL,
          warehouse_id INTEGER NOT NULL REFERENCES warehouses (id),
          quantity INTEGER NOT NULL CHECK (quantity IN (-1, 1)),
          source TEXT NOT NULL,
          source_id INTEGER NOT NULL,
          line_id INTEGER
        ) STRICT;
        CREATE INDEX serial_movements_by_serial ON serial_movements (serial_id);
        CREATE INDEX serial_movements_by_source ON serial_movements (source, source_id);
      `);
    },
  },
  {
    version: 14,
    up: (db) => {
      db.exec(`
        -- A payables line for a supplier billing in another currency also records the
        -- amount in that currency (same side as the line). The ledger itself stays in EGP.
        ALTER TABLE ledger_lines ADD COLUMN foreign_amount INTEGER CHECK (foreign_amount >= 0);

        -- Purchase lines and debit note lines are in the invoice's currency; rates are EGP per unit in millionths.
        ALTER TABLE purchase_invoices ADD COLUMN currency TEXT NOT NULL DEFAULT 'EGP';
        ALTER TABLE purchase_invoices ADD COLUMN rate INTEGER NOT NULL DEFAULT 1000000 CHECK (rate > 0);
        ALTER TABLE payments ADD COLUMN currency TEXT NOT NULL DEFAULT 'EGP';
        ALTER TABLE payments ADD COLUMN rate INTEGER NOT NULL DEFAULT 1000000 CHECK (rate > 0);
        -- What an allocation took off the document in EGP, at the document's own rate.
        ALTER TABLE payment_allocations ADD COLUMN egp_amount INTEGER;
      `);
      const insert = db.prepare("INSERT INTO accounts (code, name, type, role) VALUES (?, ?, ?, ?)");
      const codeTaken = db.prepare("SELECT 1 FROM accounts WHERE code = ?");
      for (const a of RETAIL_CHART_OF_ACCOUNTS.filter((a) => a.role === "exchange_gain" || a.role === "exchange_loss")) {
        if (db.prepare("SELECT 1 FROM accounts WHERE role = ?").get(a.role)) continue;
        let code = a.code;
        while (codeTaken.get(code)) code = `${code}1`;
        insert.run(code, a.name, a.type, a.role!);
      }
    },
  },
  {
    version: 15,
    up: (db) => {
      db.exec(`
        -- A movement may now carry value alone (a landed cost on units already held): rebuild
        -- the table without the old "quantity <> 0" check, keeping every row and id.
        CREATE TABLE stock_movements_new (
          id INTEGER PRIMARY KEY,
          date TEXT NOT NULL,
          item_id INTEGER NOT NULL REFERENCES items (id),
          warehouse_id INTEGER NOT NULL REFERENCES warehouses (id),
          quantity INTEGER NOT NULL,
          value INTEGER NOT NULL,
          source TEXT NOT NULL,
          source_id INTEGER NOT NULL,
          CHECK (quantity <> 0 OR value <> 0)
        ) STRICT;
        INSERT INTO stock_movements_new SELECT id, date, item_id, warehouse_id, quantity, value, source, source_id FROM stock_movements;
        DROP TABLE stock_movements;
        ALTER TABLE stock_movements_new RENAME TO stock_movements;
        CREATE INDEX stock_movements_by_item ON stock_movements (item_id, warehouse_id);
        CREATE INDEX stock_movements_by_source ON stock_movements (source, source_id);

        -- An import shipment groups supplier invoices and the costs of bringing them in.
        CREATE TABLE import_shipments (
          id INTEGER PRIMARY KEY,
          number INTEGER NOT NULL UNIQUE,
          date TEXT NOT NULL,
          reference TEXT NOT NULL,
          spread_by TEXT NOT NULL CHECK (spread_by IN ('value', 'quantity')),
          entry_id INTEGER NOT NULL REFERENCES journal_entries (id),
          user_id INTEGER NOT NULL REFERENCES users (id)
        ) STRICT;
        CREATE TABLE import_shipment_invoices (
          shipment_id INTEGER NOT NULL REFERENCES import_shipments (id),
          purchase_invoice_id INTEGER NOT NULL UNIQUE REFERENCES purchase_invoices (id)
        ) STRICT;
        -- Each cost in EGP, from its own payee; VAT paid at customs is input VAT, not cost.
        CREATE TABLE import_shipment_costs (
          id INTEGER PRIMARY KEY,
          shipment_id INTEGER NOT NULL REFERENCES import_shipments (id),
          kind TEXT NOT NULL CHECK (kind IN ('customs_duty', 'freight', 'clearance', 'insurance', 'other')),
          supplier_id INTEGER NOT NULL REFERENCES suppliers (id),
          amount INTEGER NOT NULL CHECK (amount >= 0),
          vat INTEGER NOT NULL CHECK (vat >= 0)
        ) STRICT;
        -- What each purchase line took of the costs: into stock, or cost of sales for units already sold.
        CREATE TABLE import_shipment_lines (
          id INTEGER PRIMARY KEY,
          shipment_id INTEGER NOT NULL REFERENCES import_shipments (id),
          purchase_line_id INTEGER NOT NULL REFERENCES purchase_invoice_lines (id),
          allocated INTEGER NOT NULL,
          to_stock INTEGER NOT NULL,
          to_cost_of_sales INTEGER NOT NULL
        ) STRICT;
      `);
    },
  },
  {
    version: 16,
    up: (db) => {
      db.exec(`
        -- VAT-inclusive price for wholesale customers; NULL means the retail price.
        ALTER TABLE item_units ADD COLUMN wholesale_price INTEGER CHECK (wholesale_price >= 0);

        -- A price offer to a customer: no ledger or stock effect until it becomes an invoice.
        CREATE TABLE quotations (
          id INTEGER PRIMARY KEY,
          number INTEGER NOT NULL UNIQUE,
          date TEXT NOT NULL,
          valid_until TEXT NOT NULL,
          customer_id INTEGER NOT NULL REFERENCES customers (id),
          reference TEXT NOT NULL,
          notes TEXT NOT NULL,
          user_id INTEGER NOT NULL REFERENCES users (id),
          invoice_id INTEGER UNIQUE REFERENCES sales_invoices (id)
        ) STRICT;
        CREATE TABLE quotation_lines (
          id INTEGER PRIMARY KEY,
          quotation_id INTEGER NOT NULL REFERENCES quotations (id),
          item_id INTEGER NOT NULL REFERENCES items (id),
          unit TEXT NOT NULL CHECK (unit IN ('base', 'pack')),
          quantity INTEGER NOT NULL CHECK (quantity > 0),
          unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
          discount INTEGER NOT NULL CHECK (discount >= 0)
        ) STRICT;
      `);
    },
  },
  {
    version: 17,
    up: (db) => {
      db.exec(`
        -- Withholding tax (الخصم والإضافة) categories, each with dated rates like VAT's.
        CREATE TABLE withholding_categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE) STRICT;
        CREATE TABLE withholding_rates (
          category_id INTEGER NOT NULL REFERENCES withholding_categories (id),
          effective_from TEXT NOT NULL,
          rate INTEGER NOT NULL CHECK (rate BETWEEN 0 AND 10000),
          PRIMARY KEY (category_id, effective_from)
        ) STRICT;
        ALTER TABLE suppliers ADD COLUMN withholding_category_id INTEGER REFERENCES withholding_categories (id);
        ALTER TABLE customers ADD COLUMN withholding_category_id INTEGER REFERENCES withholding_categories (id);
        -- The amount of a payment is what it settles; the cash moved is that less the withholding.
        ALTER TABLE payments ADD COLUMN withholding_category_id INTEGER REFERENCES withholding_categories (id);
        ALTER TABLE payments ADD COLUMN withholding_rate INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE payments ADD COLUMN withholding_base INTEGER NOT NULL DEFAULT 0 CHECK (withholding_base >= 0);
        ALTER TABLE payments ADD COLUMN withholding_amount INTEGER NOT NULL DEFAULT 0 CHECK (withholding_amount >= 0);
      `);
      // The categories of the executive regulations; the accountant confirms them before release.
      const category = db.prepare("INSERT INTO withholding_categories (name) VALUES (?)");
      const rate = db.prepare("INSERT INTO withholding_rates (category_id, effective_from, rate) VALUES (?, '2000-01-01', ?)");
      for (const [name, bp] of [
        ["توريدات", 100],
        ["خدمات ومقاولات", 300],
        ["عمولات وسمسرة وأتعاب مهنية", 500],
      ] as const) {
        rate.run(category.run(name).lastInsertRowid, bp);
      }
      const insert = db.prepare("INSERT INTO accounts (code, name, type, role) VALUES (?, ?, ?, ?)");
      const codeTaken = db.prepare("SELECT 1 FROM accounts WHERE code = ?");
      for (const a of RETAIL_CHART_OF_ACCOUNTS.filter((a) => a.role === "withholding_receivable" || a.role === "withholding_payable")) {
        if (db.prepare("SELECT 1 FROM accounts WHERE role = ?").get(a.role)) continue;
        let code = a.code;
        while (codeTaken.get(code)) code = `${code}1`;
        insert.run(code, a.name, a.type, a.role!);
      }
    },
  },
  {
    version: 18,
    up: (db) => {
      db.exec(`
        -- Nothing is posted on or before the lock date.
        ALTER TABLE business_settings ADD COLUMN lock_date TEXT;
        -- Ticked as on the bank statement.
        ALTER TABLE ledger_lines ADD COLUMN cleared INTEGER NOT NULL DEFAULT 0 CHECK (cleared IN (0, 1));
        -- The entry that reverses this one, once it is void.
        ALTER TABLE journal_entries ADD COLUMN voided_by INTEGER REFERENCES journal_entries (id);

        CREATE TABLE expenses (
          id INTEGER PRIMARY KEY,
          number INTEGER NOT NULL UNIQUE,
          date TEXT NOT NULL,
          account_id INTEGER NOT NULL REFERENCES accounts (id),
          amount INTEGER NOT NULL CHECK (amount > 0),
          vat INTEGER NOT NULL CHECK (vat >= 0),
          -- Paid from a money account, or owed to a supplier.
          money_account_id INTEGER REFERENCES accounts (id),
          supplier_id INTEGER REFERENCES suppliers (id),
          memo TEXT NOT NULL,
          entry_id INTEGER NOT NULL REFERENCES journal_entries (id),
          user_id INTEGER NOT NULL REFERENCES users (id),
          CHECK ((money_account_id IS NULL) <> (supplier_id IS NULL))
        ) STRICT;
        CREATE TABLE money_transfers (
          id INTEGER PRIMARY KEY,
          number INTEGER NOT NULL UNIQUE,
          date TEXT NOT NULL,
          from_account_id INTEGER NOT NULL REFERENCES accounts (id),
          to_account_id INTEGER NOT NULL REFERENCES accounts (id),
          amount INTEGER NOT NULL CHECK (amount > 0),
          memo TEXT NOT NULL,
          entry_id INTEGER NOT NULL REFERENCES journal_entries (id),
          user_id INTEGER NOT NULL REFERENCES users (id)
        ) STRICT;
      `);
    },
  },
  {
    version: 19,
    up: (db) => {
      db.exec(`
        -- Below this many base thousandths in stock, the item shows on the low-stock list.
        ALTER TABLE items ADD COLUMN min_quantity INTEGER CHECK (min_quantity >= 0);

        CREATE TABLE stock_counts (
          id INTEGER PRIMARY KEY,
          date TEXT NOT NULL,
          warehouse_id INTEGER NOT NULL REFERENCES warehouses (id),
          memo TEXT NOT NULL,
          entry_id INTEGER REFERENCES journal_entries (id),
          user_id INTEGER NOT NULL REFERENCES users (id)
        ) STRICT;
        -- What the books held, what was found, and the gain (positive) or loss posted.
        CREATE TABLE stock_count_lines (
          id INTEGER PRIMARY KEY,
          count_id INTEGER NOT NULL REFERENCES stock_counts (id),
          item_id INTEGER NOT NULL REFERENCES items (id),
          expected INTEGER NOT NULL,
          counted INTEGER NOT NULL CHECK (counted >= 0),
          value INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE write_offs (
          id INTEGER PRIMARY KEY,
          date TEXT NOT NULL,
          warehouse_id INTEGER NOT NULL REFERENCES warehouses (id),
          reason TEXT NOT NULL,
          entry_id INTEGER REFERENCES journal_entries (id),
          user_id INTEGER NOT NULL REFERENCES users (id)
        ) STRICT;
        CREATE TABLE write_off_lines (
          id INTEGER PRIMARY KEY,
          write_off_id INTEGER NOT NULL REFERENCES write_offs (id),
          item_id INTEGER NOT NULL REFERENCES items (id),
          quantity INTEGER NOT NULL CHECK (quantity > 0),
          value INTEGER NOT NULL
        ) STRICT;
      `);
    },
  },
  {
    version: 20,
    up: (db) => {
      db.exec(`
        -- Where this business is backed up every day (a folder on the PC that holds the file), and when it last was.
        ALTER TABLE business_settings ADD COLUMN backup_folder TEXT;
        ALTER TABLE business_settings ADD COLUMN last_backup_at TEXT;
      `);
    },
  },
  {
    version: 21,
    up: (db) => {
      db.exec(`
        -- E-invoicing with the Egyptian Tax Authority: off unless the business turns it on.
        -- The client secret is sealed by the PC that saved it (Windows DPAPI), never stored readable.
        CREATE TABLE eta_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
          environment TEXT NOT NULL DEFAULT 'preprod' CHECK (environment IN ('preprod', 'production')),
          client_id TEXT NOT NULL DEFAULT '',
          client_secret TEXT NOT NULL DEFAULT '',
          activity_code TEXT NOT NULL DEFAULT '',
          governate TEXT NOT NULL DEFAULT '',
          region_city TEXT NOT NULL DEFAULT '',
          street TEXT NOT NULL DEFAULT '',
          building_number TEXT NOT NULL DEFAULT '',
          certificate TEXT NOT NULL DEFAULT ''
        ) STRICT;
        INSERT INTO eta_settings (id) VALUES (1);

        -- Each sales invoice and credit note sent, or waiting to be sent, to the ETA.
        CREATE TABLE eta_documents (
          id INTEGER PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('invoice', 'credit_note')),
          document_id INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'failed', 'submitted', 'valid', 'invalid', 'cancelled')),
          uuid TEXT NOT NULL DEFAULT '',
          error TEXT NOT NULL DEFAULT '',
          issued_at TEXT,
          updated_at TEXT NOT NULL,
          UNIQUE (kind, document_id)
        ) STRICT;

        -- The address parts an e-invoice needs for a company customer; "address" is the street.
        ALTER TABLE customers ADD COLUMN governate TEXT NOT NULL DEFAULT '';
        ALTER TABLE customers ADD COLUMN region_city TEXT NOT NULL DEFAULT '';
        ALTER TABLE customers ADD COLUMN building_number TEXT NOT NULL DEFAULT '';
      `);
    },
  },
  {
    version: 22,
    up: (db) => {
      db.exec(`
        -- E-receipts for till sales: the POS as registered with the ETA. Secrets are sealed by the PC.
        ALTER TABLE eta_settings ADD COLUMN receipts_enabled INTEGER NOT NULL DEFAULT 0 CHECK (receipts_enabled IN (0, 1));
        ALTER TABLE eta_settings ADD COLUMN pos_serial TEXT NOT NULL DEFAULT '';
        ALTER TABLE eta_settings ADD COLUMN pos_os_version TEXT NOT NULL DEFAULT '';
        ALTER TABLE eta_settings ADD COLUMN pos_model TEXT NOT NULL DEFAULT '';
        ALTER TABLE eta_settings ADD COLUMN pos_client_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE eta_settings ADD COLUMN pos_client_secret TEXT NOT NULL DEFAULT '';
        ALTER TABLE eta_settings ADD COLUMN pos_preshared_key TEXT NOT NULL DEFAULT '';
        -- The UUID of the last e-receipt this POS issued: the next one names it.
        ALTER TABLE eta_settings ADD COLUMN pos_last_uuid TEXT NOT NULL DEFAULT '';

        -- Each e-receipt names the one before it; returns join that chain too. Why one failed, when it did.
        ALTER TABLE sales_returns ADD COLUMN eta_previous_uuid TEXT NOT NULL DEFAULT '';
        ALTER TABLE sales_receipts ADD COLUMN eta_error TEXT NOT NULL DEFAULT '';
        ALTER TABLE sales_returns ADD COLUMN eta_error TEXT NOT NULL DEFAULT '';
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
