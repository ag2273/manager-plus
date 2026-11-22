
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
      