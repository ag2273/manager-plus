
        -- The first-use setup: sales and purchases open once the opening balances are confirmed,
        -- or the owner says the business is new with nothing to bring forward (#97, note 10).
        -- A file already in use is set up: its row is written now; a new file gets none until confirmed.
        CREATE TABLE setup (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          finished_at TEXT NOT NULL,
          mode TEXT NOT NULL CHECK (mode IN ('opening', 'new', 'existing'))
        ) STRICT;
        INSERT INTO setup (id, finished_at, mode)
          SELECT 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'existing' FROM business_settings;
