
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
      