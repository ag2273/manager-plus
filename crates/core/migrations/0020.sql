
        -- Where this business is backed up every day (a folder on the PC that holds the file), and when it last was.
        ALTER TABLE business_settings ADD COLUMN backup_folder TEXT;
        ALTER TABLE business_settings ADD COLUMN last_backup_at TEXT;
      