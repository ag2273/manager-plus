
        -- VAT-inclusive price for wholesale customers; NULL means the retail price.
        ALTER TABLE item_units ADD COLUMN wholesale_price INTEGER CHECK (wholesale_price >= 0);

        -- A price offer to a customer: no ledger or stock effect until it becomes an invoice.
        CREATE TABLE quotations (
          id INTEGER PRIMARY KEY,
          number INTEGER NOT NULL UNIQUE,
          date TEXT NOT NULL,
          valid_until TEXT NOT NULL,
          customer_id INTEGER NOT NULL REFERENCES customers (id),
          reference TEXT NOT NULL,
          notes TEXT NOT NULL,
          user_id INTEGER NOT NULL REFERENCES users (id),
          invoice_id INTEGER UNIQUE REFERENCES sales_invoices (id)
        ) STRICT;
        CREATE TABLE quotation_lines (
          id INTEGER PRIMARY KEY,
          quotation_id INTEGER NOT NULL REFERENCES quotations (id),
          item_id INTEGER NOT NULL REFERENCES items (id),
          unit TEXT NOT NULL CHECK (unit IN ('base', 'pack')),
          quantity INTEGER NOT NULL CHECK (quantity > 0),
          unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
          discount INTEGER NOT NULL CHECK (discount >= 0)
        ) STRICT;
      