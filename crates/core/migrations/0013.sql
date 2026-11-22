
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
      