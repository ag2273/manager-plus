
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
      