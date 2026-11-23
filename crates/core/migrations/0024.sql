        -- A till receipt replaced by a tax invoice to a company customer (#97, note 7): the receipt
        -- is returned in full to that customer's account and the invoice raised in its place, so the
        -- sale is counted once. The return's credit settles the invoice.
        CREATE TABLE receipt_invoices (
          receipt_id INTEGER PRIMARY KEY REFERENCES sales_receipts (id),
          return_id INTEGER NOT NULL UNIQUE REFERENCES sales_returns (id),
          invoice_id INTEGER NOT NULL UNIQUE REFERENCES sales_invoices (id)
        ) STRICT;
