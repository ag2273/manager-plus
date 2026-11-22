
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
      