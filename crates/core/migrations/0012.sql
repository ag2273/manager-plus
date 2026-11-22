
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
      