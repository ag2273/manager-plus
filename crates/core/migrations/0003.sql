
        CREATE TABLE tax_codes (
          id INTEGER PRIMARY KEY,
          kind TEXT NOT NULL UNIQUE CHECK (kind IN ('standard', 'zero_rated', 'exempt')),
          name TEXT NOT NULL
        ) STRICT;

        -- Rates in basis points (1400 = 14%), each in force from its date until the next one.
        CREATE TABLE tax_rates (
          tax_code_id INTEGER NOT NULL REFERENCES tax_codes (id),
          effective_from TEXT NOT NULL,
          rate INTEGER NOT NULL CHECK (rate BETWEEN 0 AND 10000),
          PRIMARY KEY (tax_code_id, effective_from)
        ) STRICT;

        CREATE TABLE items (
          id INTEGER PRIMARY KEY,
          name_ar TEXT NOT NULL,
          name_en TEXT NOT NULL DEFAULT '',
          code TEXT UNIQUE,
          tax_code_id INTEGER NOT NULL REFERENCES tax_codes (id),
          egs_code TEXT NOT NULL DEFAULT '',
          active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
        ) STRICT;

        -- Every item has one base unit (size 1000 = one base unit) and at most one pack unit.
        CREATE TABLE item_units (
          id INTEGER PRIMARY KEY,
          item_id INTEGER NOT NULL REFERENCES items (id),
          kind TEXT NOT NULL CHECK (kind IN ('base', 'pack')),
          name TEXT NOT NULL,
          size INTEGER NOT NULL CHECK (size > 0),
          barcode TEXT UNIQUE,
          sale_price INTEGER NOT NULL CHECK (sale_price >= 0),
          UNIQUE (item_id, kind),
          CHECK (kind = 'pack' OR size = 1000)
        ) STRICT;
      