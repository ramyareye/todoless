-- Register endpoint rate limiting buckets
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS register_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_register_rate_limits_window
  ON register_rate_limits(window_started_at);
