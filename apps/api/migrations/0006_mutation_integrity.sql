-- Preserve existing task clients and history while guarding concurrent writes.
ALTER TABLE tasks ADD COLUMN last_mutation_id TEXT;
ALTER TABLE projects ADD COLUMN last_mutation_id TEXT;
CREATE TABLE project_history_next (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  actor_user_id TEXT,
  change_type TEXT NOT NULL CHECK(change_type IN (
    'CREATED',
    'UPDATED',
    'PRIORITY_RULE_CHANGED',
    'DEADLINE_CHANGED',
    'DELETED',
    'RESTORED'
  )),
  change_reason TEXT NOT NULL DEFAULT 'manual' CHECK(change_reason IN (
    'manual',
    'deadline_shift',
    'rebalancing',
    'scope_change',
    'dependency_blocked',
    'system'
  )),
  from_value_json TEXT,
  to_value_json TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
);


INSERT INTO project_history_next SELECT * FROM project_history;
DROP TABLE project_history;
ALTER TABLE project_history_next RENAME TO project_history;
CREATE INDEX idx_project_history_project_created ON project_history(project_id, created_at DESC);
CREATE INDEX idx_project_history_workspace_created ON project_history(workspace_id, created_at DESC);
