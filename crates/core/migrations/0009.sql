
        CREATE TABLE customers (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          phone TEXT NOT NULL DEFAULT '',
          tax_registration_number TEXT NOT NULL DEFAULT '',
          active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
        ) STRICT;

        -- The customer a receivables line belongs to, so each customer's balance comes from the ledger.
        ALTER TABLE ledger_lines ADD COLUMN customer_id INTEGER REFERENCES customers (id);
        CREATE INDEX ledger_lines_by_customer ON ledger_lines (customer_id) WHERE customer_id IS NOT NULL;

        ALTER TABLE sales_receipts ADD COLUMN customer_id INTEGER REFERENCES customers (id);

        -- What each tender paid towards a receipt; cash is after change. The unpaid rest is on credit.
        CREATE TABLE sales_receipt_payments (
          id INTEGER PRIMARY KEY,
          receipt_id INTEGER NOT NULL REFERENCES sales_receipts (id),
          method TEXT NOT NULL CHECK (method IN ('cash', 'card', 'wallet')),
          amount INTEGER NOT NULL CHECK (amount > 0)
        ) STRICT;
        CREATE INDEX sales_receipt_payments_by_receipt ON sales_receipt_payments (receipt_id);

        -- Receipts made before tenders were recorded were all paid in cash.
        INSERT INTO sales_receipt_payments (receipt_id, method, amount)
          SELECT r.id, 'cash', SUM(l.gross) FROM sales_receipts r JOIN sales_receipt_lines l ON l.receipt_id = r.id
           GROUP BY r.id HAVING SUM(l.gross) > 0;
      