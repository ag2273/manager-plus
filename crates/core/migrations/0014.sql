
        -- A payables line for a supplier billing in another currency also records the
        -- amount in that currency (same side as the line). The ledger itself stays in EGP.
        ALTER TABLE ledger_lines ADD COLUMN foreign_amount INTEGER CHECK (foreign_amount >= 0);

        -- Purchase lines and debit note lines are in the invoice's currency; rates are EGP per unit in millionths.
        ALTER TABLE purchase_invoices ADD COLUMN currency TEXT NOT NULL DEFAULT 'EGP';
        ALTER TABLE purchase_invoices ADD COLUMN rate INTEGER NOT NULL DEFAULT 1000000 CHECK (rate > 0);
        ALTER TABLE payments ADD COLUMN currency TEXT NOT NULL DEFAULT 'EGP';
        ALTER TABLE payments ADD COLUMN rate INTEGER NOT NULL DEFAULT 1000000 CHECK (rate > 0);
        -- What an allocation took off the document in EGP, at the document's own rate.
        ALTER TABLE payment_allocations ADD COLUMN egp_amount INTEGER;
      