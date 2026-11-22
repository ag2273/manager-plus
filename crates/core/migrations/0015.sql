
        -- A movement may now carry value alone (a landed cost on units already held): rebuild
        -- the table without the old "quantity <> 0" check, keeping every row and id.
        CREATE TABLE stock_movements_new (
          id INTEGER PRIMARY KEY,
          date TEXT NOT NULL,
          item_id INTEGER NOT NULL REFERENCES items (id),
          warehouse_id INTEGER NOT NULL REFERENCES warehouses (id),
          quantity INTEGER NOT NULL,
          value INTEGER NOT NULL,
          source TEXT NOT NULL,
          source_id INTEGER NOT NULL,
          CHECK (quantity <> 0 OR value <> 0)
        ) STRICT;
        INSERT INTO stock_movements_new SELECT id, date, item_id, warehouse_id, quantity, value, source, source_id FROM stock_movements;
        DROP TABLE stock_movements;
        ALTER TABLE stock_movements_new RENAME TO stock_movements;
        CREATE INDEX stock_movements_by_item ON stock_movements (item_id, warehouse_id);
        CREATE INDEX stock_movements_by_source ON stock_movements (source, source_id);

        -- An import shipment groups supplier invoices and the costs of bringing them in.
        CREATE TABLE import_shipments (
          id INTEGER PRIMARY KEY,
          number INTEGER NOT NULL UNIQUE,
          date TEXT NOT NULL,
          reference TEXT NOT NULL,
          spread_by TEXT NOT NULL CHECK (spread_by IN ('value', 'quantity')),
          entry_id INTEGER NOT NULL REFERENCES journal_entries (id),
          user_id INTEGER NOT NULL REFERENCES users (id)
        ) STRICT;
        CREATE TABLE import_shipment_invoices (
          shipment_id INTEGER NOT NULL REFERENCES import_shipments (id),
          purchase_invoice_id INTEGER NOT NULL UNIQUE REFERENCES purchase_invoices (id)
        ) STRICT;
        -- Each cost in EGP, from its own payee; VAT paid at customs is input VAT, not cost.
        CREATE TABLE import_shipment_costs (
          id INTEGER PRIMARY KEY,
          shipment_id INTEGER NOT NULL REFERENCES import_shipments (id),
          kind TEXT NOT NULL CHECK (kind IN ('customs_duty', 'freight', 'clearance', 'insurance', 'other')),
          supplier_id INTEGER NOT NULL REFERENCES suppliers (id),
          amount INTEGER NOT NULL CHECK (amount >= 0),
          vat INTEGER NOT NULL CHECK (vat >= 0)
        ) STRICT;
        -- What each purchase line took of the costs: into stock, or cost of sales for units already sold.
        CREATE TABLE import_shipment_lines (
          id INTEGER PRIMARY KEY,
          shipment_id INTEGER NOT NULL REFERENCES import_shipments (id),
          purchase_line_id INTEGER NOT NULL REFERENCES purchase_invoice_lines (id),
          allocated INTEGER NOT NULL,
          to_stock INTEGER NOT NULL,
          to_cost_of_sales INTEGER NOT NULL
        ) STRICT;
      