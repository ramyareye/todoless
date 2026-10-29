-- Opt-in delivery workflow. Existing tasks and statuses are preserved.
ALTER TABLE tasks ADD COLUMN delivery_state TEXT CHECK(delivery_state IN ('BACKLOG','READY','ACTIVE','BLOCKED','REVIEW','VERIFY','DONE','ARCHIVED'));
ALTER TABLE tasks ADD COLUMN delivery_json TEXT;
CREATE INDEX idx_tasks_delivery_person ON tasks(workspace_id,assignee_user_id,deleted_at,delivery_state,status);
CREATE TABLE task_dependencies (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY(task_id,depends_on_task_id),
  CHECK(task_id != depends_on_task_id)
);
CREATE INDEX idx_dependencies_target ON task_dependencies(depends_on_task_id,workspace_id);
