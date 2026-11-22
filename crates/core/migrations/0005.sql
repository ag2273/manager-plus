
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
      