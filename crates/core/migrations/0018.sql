
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
      