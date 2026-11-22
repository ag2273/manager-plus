
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          role TEXT NOT NULL CHECK (role IN ('manager', 'accountant', 'cashier', 'storekeeper')),
          password_hash TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
        ) STRICT;

        -- Append-only record of every command that changed the books: who, when, what.
        CREATE TABLE audit_log (
          id INTEGER PRIMARY KEY,
          at TEXT NOT NULL,
          user_id INTEGER NOT NULL REFERENCES users (id),
          action TEXT NOT NULL,
          entity_id INTEGER,
          detail TEXT NOT NULL
        ) STRICT;

        CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
          BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
        CREATE TRIGGER audit_log_no_removal BEFORE DELETE ON audit_log
          BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
      