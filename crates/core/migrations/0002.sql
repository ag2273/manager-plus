
        CREATE TABLE accounts (
          id INTEGER PRIMARY KEY,
          code TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense')),
          role TEXT UNIQUE,
          active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
        ) STRICT;

        CREATE TABLE journal_entries (
          id INTEGER PRIMARY KEY,
          date TEXT NOT NULL,
          memo TEXT NOT NULL,
          kind TEXT NOT NULL
        ) STRICT;

        CREATE TABLE ledger_lines (
          id INTEGER PRIMARY KEY,
          entry_id INTEGER NOT NULL REFERENCES journal_entries (id),
          account_id INTEGER NOT NULL REFERENCES accounts (id),
          debit INTEGER NOT NULL CHECK (debit >= 0),
          credit INTEGER NOT NULL CHECK (credit >= 0),
          memo TEXT NOT NULL DEFAULT '',
          CHECK ((debit = 0) <> (credit = 0))
        ) STRICT;

        CREATE INDEX ledger_lines_by_account ON ledger_lines (account_id);
        CREATE INDEX journal_entries_by_date ON journal_entries (date);
      