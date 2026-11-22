
        -- E-invoicing with the Egyptian Tax Authority: off unless the business turns it on.
        -- The client secret is sealed by the PC that saved it (Windows DPAPI), never stored readable.
        CREATE TABLE eta_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
          environment TEXT NOT NULL DEFAULT 'preprod' CHECK (environment IN ('preprod', 'production')),
          client_id TEXT NOT NULL DEFAULT '',
          client_secret TEXT NOT NULL DEFAULT '',
          activity_code TEXT NOT NULL DEFAULT '',
          governate TEXT NOT NULL DEFAULT '',
          region_city TEXT NOT NULL DEFAULT '',
          street TEXT NOT NULL DEFAULT '',
          building_number TEXT NOT NULL DEFAULT '',
          certificate TEXT NOT NULL DEFAULT ''
        ) STRICT;
        INSERT INTO eta_settings (id) VALUES (1);

        -- Each sales invoice and credit note sent, or waiting to be sent, to the ETA.
        CREATE TABLE eta_documents (
          id INTEGER PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('invoice', 'credit_note')),
          document_id INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'failed', 'submitted', 'valid', 'invalid', 'cancelled')),
          uuid TEXT NOT NULL DEFAULT '',
          error TEXT NOT NULL DEFAULT '',
          issued_at TEXT,
          updated_at TEXT NOT NULL,
          UNIQUE (kind, document_id)
        ) STRICT;

        -- The address parts an e-invoice needs for a company customer; "address" is the street.
        ALTER TABLE customers ADD COLUMN governate TEXT NOT NULL DEFAULT '';
        ALTER TABLE customers ADD COLUMN region_city TEXT NOT NULL DEFAULT '';
        ALTER TABLE customers ADD COLUMN building_number TEXT NOT NULL DEFAULT '';
      