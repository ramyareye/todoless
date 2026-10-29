-- Optional per-member project boundary. Existing memberships keep workspace access.
-- NULL means workspace access, [] means no projects. Keep revisions for safe retries.
CREATE TABLE member_project_access (
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  project_ids_json TEXT CHECK(project_ids_json IS NULL OR (json_valid(project_ids_json) AND json_type(project_ids_json) = 'array')),
  version INTEGER NOT NULL CHECK(version > 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(workspace_id,user_id),
  FOREIGN KEY(workspace_id,user_id) REFERENCES memberships(workspace_id,user_id) ON DELETE CASCADE
);
-- Old operation responses must not be replayed across an access-policy change.
ALTER TABLE delivery_operations ADD COLUMN access_version INTEGER NOT NULL DEFAULT 0;
