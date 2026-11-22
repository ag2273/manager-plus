
        -- E-receipts for till sales: the POS as registered with the ETA. Secrets are sealed by the PC.
        ALTER TABLE eta_settings ADD COLUMN receipts_enabled INTEGER NOT NULL DEFAULT 0 CHECK (receipts_enabled IN (0, 1));
        ALTER TABLE eta_settings ADD COLUMN pos_serial TEXT NOT NULL DEFAULT '';
        ALTER TABLE eta_settings ADD COLUMN pos_os_version TEXT NOT NULL DEFAULT '';
        ALTER TABLE eta_settings ADD COLUMN pos_model TEXT NOT NULL DEFAULT '';
        ALTER TABLE eta_settings ADD COLUMN pos_client_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE eta_settings ADD COLUMN pos_client_secret TEXT NOT NULL DEFAULT '';
        ALTER TABLE eta_settings ADD COLUMN pos_preshared_key TEXT NOT NULL DEFAULT '';
        -- The UUID of the last e-receipt this POS issued: the next one names it.
        ALTER TABLE eta_settings ADD COLUMN pos_last_uuid TEXT NOT NULL DEFAULT '';

        -- Each e-receipt names the one before it; returns join that chain too. Why one failed, when it did.
        ALTER TABLE sales_returns ADD COLUMN eta_previous_uuid TEXT NOT NULL DEFAULT '';
        ALTER TABLE sales_receipts ADD COLUMN eta_error TEXT NOT NULL DEFAULT '';
        ALTER TABLE sales_returns ADD COLUMN eta_error TEXT NOT NULL DEFAULT '';
      