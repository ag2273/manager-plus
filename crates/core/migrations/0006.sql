
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
      