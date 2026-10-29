-- Separate from signup/invitations. Existing keys and account data are untouched.
CREATE TABLE api_key_recovery_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  token_prefix TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_key_recovery_user ON api_key_recovery_tokens(user_id, consumed_at);

-- Hashes of namespaced IP/email buckets. Never store raw addresses here.
CREATE TABLE key_recovery_rate_limits (
  bucket_hash TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL CHECK(attempt_count > 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
