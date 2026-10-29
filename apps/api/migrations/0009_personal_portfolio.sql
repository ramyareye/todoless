-- Private execution preferences only. No task, deadline or time-review mutation.
CREATE TABLE personal_portfolios (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  version INTEGER NOT NULL CHECK(version > 0),
  document_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE personal_availability (
  user_id TEXT NOT NULL REFERENCES users(id),
  local_date TEXT NOT NULL,
  minutes INTEGER NOT NULL CHECK(minutes BETWEEN 0 AND 120),
  PRIMARY KEY(user_id, local_date)
);
CREATE TABLE personal_portfolio_operations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, idempotency_key)
);
