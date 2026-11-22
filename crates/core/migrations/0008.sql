
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
      