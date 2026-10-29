-- No real people, rates, currencies, caps, or pilot records are seeded.
CREATE TABLE time_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  timezone TEXT NOT NULL,
  week_start INTEGER NOT NULL CHECK(week_start BETWEEN 0 AND 6),
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE time_approvers (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY(workspace_id, user_id)
);
CREATE TABLE time_terms (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  effective_from TEXT NOT NULL,
  rate_minor_per_hour INTEGER,
  currency TEXT,
  minor_unit_scale INTEGER,
  weekly_cap_minutes INTEGER,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id, user_id, effective_from),
  CHECK((rate_minor_per_hour IS NULL AND currency IS NULL AND minor_unit_scale IS NULL) OR
    (rate_minor_per_hour >= 0 AND currency IS NOT NULL AND minor_unit_scale BETWEEN 0 AND 4))
);
CREATE TABLE time_weeks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  week_start_date TEXT NOT NULL,
  timezone TEXT NOT NULL,
  week_start INTEGER NOT NULL,
  version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('draft','submitted','approved','changes_requested')),
  document_json TEXT NOT NULL,
  UNIQUE(workspace_id, user_id, week_start_date)
);
CREATE INDEX idx_time_weeks_workspace_date ON time_weeks(workspace_id, week_start_date, id);
CREATE TABLE time_events (
  id TEXT PRIMARY KEY,
  week_id TEXT NOT NULL REFERENCES time_weeks(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  reason TEXT,
  version INTEGER NOT NULL,
  document_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(week_id, version)
);
CREATE TABLE delivery_operations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id, actor_user_id, idempotency_key)
);
