-- The licence server's D1 database. Apply with:
--   wrangler d1 execute manager-plus-licences --remote --file licence-server/schema.sql

-- One row per sold licence. The key itself is never stored, only its SHA-256 and its last four characters.
CREATE TABLE IF NOT EXISTS licences (
  id INTEGER PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  key_hint TEXT NOT NULL,
  company TEXT NOT NULL,
  users INTEGER NOT NULL CHECK (users >= 1),
  -- The last day of the support plan, YYYY-MM-DD.
  support_until TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

-- Each PC a licence was activated on. The current one has no ended_at; a move, reset or revoke ends it.
CREATE TABLE IF NOT EXISTS activations (
  id INTEGER PRIMARY KEY,
  licence_id INTEGER NOT NULL REFERENCES licences (id),
  machine TEXT NOT NULL,
  app_version TEXT NOT NULL DEFAULT '',
  activated_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT CHECK (end_reason IN ('move', 'reset', 'revoke'))
);
CREATE INDEX IF NOT EXISTS activations_by_licence ON activations (licence_id, ended_at);

-- Payments recorded by hand: licence sales and yearly support renewals. Amounts in piastres.
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  licence_id INTEGER NOT NULL REFERENCES licences (id),
  paid_on TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  note TEXT NOT NULL DEFAULT '',
  recorded_at TEXT NOT NULL
);

-- Fixed-window counters for rate limiting, by bucket (e.g. "activate:<ip>").
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
