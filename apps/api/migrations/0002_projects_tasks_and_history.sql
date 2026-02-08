-- Todoless Week-2 core schema: projects/tasks + timeline history
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_projects_workspace_created
  ON projects(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS labels (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6366f1',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id, name),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_labels_workspace_created
  ON labels(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT,
  parent_task_id TEXT,
  assignee_user_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'TODO' CHECK(status IN ('TODO', 'IN_PROGRESS', 'DONE', 'ARCHIVED')),
  priority TEXT NOT NULL DEFAULT 'P2' CHECK(priority IN ('P0', 'P1', 'P2', 'P3')),
  due_at TEXT,
  completed_at TEXT,
  metadata_json TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
  FOREIGN KEY (parent_task_id) REFERENCES tasks(id) ON DELETE SET NULL,
  FOREIGN KEY (assignee_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_workspace_updated
  ON tasks(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace_status_priority_due
  ON tasks(workspace_id, status, priority, due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_project_created
  ON tasks(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_parent
  ON tasks(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee
  ON tasks(assignee_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS task_labels (
  task_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (task_id, label_id),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (label_id) REFERENCES labels(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_labels_label
  ON task_labels(label_id);

-- Timeline and priority/deadline history for planning intelligence
CREATE TABLE IF NOT EXISTS task_history (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  actor_user_id TEXT,
  change_type TEXT NOT NULL CHECK(change_type IN (
    'CREATED',
    'UPDATED',
    'STATUS_CHANGED',
    'PRIORITY_CHANGED',
    'DUE_DATE_CHANGED',
    'ASSIGNEE_CHANGED',
    'DELETED',
    'RESTORED'
  )),
  change_reason TEXT NOT NULL DEFAULT 'manual' CHECK(change_reason IN (
    'manual',
    'deadline_shift',
    'dependency_blocked',
    'rebalancing',
    'system'
  )),
  from_value_json TEXT,
  to_value_json TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_task_history_task_created
  ON task_history(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_history_workspace_created
  ON task_history(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_history_change_type
  ON task_history(workspace_id, change_type, created_at DESC);

CREATE TABLE IF NOT EXISTS project_history (
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

CREATE INDEX IF NOT EXISTS idx_project_history_project_created
  ON project_history(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_history_workspace_created
  ON project_history(workspace_id, created_at DESC);
