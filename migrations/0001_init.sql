-- A dry run stores the exact change it previewed. The confirm step consumes the row once.
CREATE TABLE pending_writes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  tool TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  before_json TEXT NOT NULL,
  before_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

-- One row per write attempt, inserted as 'pending' before Google is called and
-- finalized afterwards. A row left 'pending' or 'indeterminate' means the outcome
-- must be checked with a read tool before anything is retried. Never deleted.
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  email TEXT NOT NULL,
  tool TEXT NOT NULL,
  pending_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT,
  result TEXT NOT NULL CHECK (result IN ('pending', 'success', 'error', 'indeterminate', 'rejected_drift')),
  error TEXT,
  credential TEXT NOT NULL
);
CREATE INDEX audit_log_at ON audit_log (at);

-- Serializes confirmations per Google setting across Worker instances. A lock is
-- held from the re-read through the write and expires on its own if a Worker dies.
CREATE TABLE write_locks (
  resource TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
