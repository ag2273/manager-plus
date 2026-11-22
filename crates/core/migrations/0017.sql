
        -- Withholding tax (الخصم والإضافة) categories, each with dated rates like VAT's.
        CREATE TABLE withholding_categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE) STRICT;
        CREATE TABLE withholding_rates (
          category_id INTEGER NOT NULL REFERENCES withholding_categories (id),
          effective_from TEXT NOT NULL,
          rate INTEGER NOT NULL CHECK (rate BETWEEN 0 AND 10000),
          PRIMARY KEY (category_id, effective_from)
        ) STRICT;
        ALTER TABLE suppliers ADD COLUMN withholding_category_id INTEGER REFERENCES withholding_categories (id);
        ALTER TABLE customers ADD COLUMN withholding_category_id INTEGER REFERENCES withholding_categories (id);
        -- The amount of a payment is what it settles; the cash moved is that less the withholding.
        ALTER TABLE payments ADD COLUMN withholding_category_id INTEGER REFERENCES withholding_categories (id);
        ALTER TABLE payments ADD COLUMN withholding_rate INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE payments ADD COLUMN withholding_base INTEGER NOT NULL DEFAULT 0 CHECK (withholding_base >= 0);
        ALTER TABLE payments ADD COLUMN withholding_amount INTEGER NOT NULL DEFAULT 0 CHECK (withholding_amount >= 0);
      