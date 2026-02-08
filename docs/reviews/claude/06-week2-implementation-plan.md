# Week 2 Implementation Plan: Projects + Tasks

## Goal
Ship working project and task CRUD endpoints with proper multi-tenant isolation, soft deletes, and optimistic concurrency.

## Session Breakdown (6-8 hours)

### Session 1 (2h): Schema + Code Split

**Step 1: Split index.ts into modules (~1h)**

Create this structure:
```
src/
  index.ts           → app setup + route registration only
  middleware/
    request-id.ts
    auth.ts
  routes/
    health.ts
    auth.ts
    workspaces.ts
    members.ts
    api-keys.ts
    projects.ts       (new)
    tasks.ts          (new)
  services/
    api-keys.ts
    audit.ts
  lib/
    ids.ts
    response.ts
    types.ts
```

**Step 2: Write migration 0002_projects_tasks.sql (~30min)**

```sql
-- Projects
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

CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id, created_at);

-- Labels
CREATE TABLE IF NOT EXISTS labels (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6366f1',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id, name),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

-- Tasks
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT,
  parent_task_id TEXT,
  assignee_user_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'TODO' CHECK(status IN ('TODO','IN_PROGRESS','DONE','ARCHIVED')),
  priority TEXT NOT NULL DEFAULT 'P2' CHECK(priority IN ('P0','P1','P2','P3')),
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

CREATE INDEX IF NOT EXISTS idx_tasks_workspace_updated ON tasks(workspace_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace_status ON tasks(workspace_id, status, priority, due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_user_id);

-- Task-Label join
CREATE TABLE IF NOT EXISTS task_labels (
  task_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  PRIMARY KEY (task_id, label_id),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (label_id) REFERENCES labels(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_labels_label ON task_labels(label_id);
```

**Step 3: Apply migration and verify (~30min)**
```bash
npm run db:migrate:local
```

### Session 2 (2h): Project Endpoints

Implement in `src/routes/projects.ts`:

```
POST   /v1/workspaces/:wsId/projects     (MEMBER+ scope: workspace:write)
GET    /v1/workspaces/:wsId/projects     (VIEWER+ scope: workspace:read)
GET    /v1/projects/:projectId           (VIEWER+)
PATCH  /v1/projects/:projectId           (MEMBER+)
DELETE /v1/projects/:projectId           (ADMIN+, soft delete)
```

Validation schemas (Zod):
- create: `{ name: string(1-100), description?: string(0-500) }`
- update: `{ name?: string(1-100), description?: string(0-500) }`

Business rules:
- Projects are workspace-scoped
- Soft delete sets `deleted_at`, doesn't remove the row
- List endpoint excludes soft-deleted by default
- Audit log on create/update/delete

### Session 3 (2-3h): Task Endpoints

Implement in `src/routes/tasks.ts`:

```
POST   /v1/workspaces/:wsId/tasks        (MEMBER+)
GET    /v1/workspaces/:wsId/tasks        (VIEWER+, with filters)
GET    /v1/tasks/:taskId                  (VIEWER+)
PATCH  /v1/tasks/:taskId                  (MEMBER+, with version check)
DELETE /v1/tasks/:taskId                  (MEMBER+, soft delete)
POST   /v1/tasks/:taskId/restore         (ADMIN+)
```

Filters on list endpoint:
- `?status=TODO` — filter by status
- `?priority=P1` — filter by priority
- `?project_id=prj_123` — filter by project
- `?assignee_id=usr_456` — filter by assignee
- `?due_from=2026-02-01&due_to=2026-02-28` — date range
- `?include_deleted=true` — admin scope only
- `?limit=50` — max 100 per request

Optimistic concurrency on PATCH:
- Client sends `If-Match-Version: 3` header (or `version` in body)
- Server checks task's current version
- If match: update and increment version
- If mismatch: return 409 with current task snapshot

### Session 4 (1h): Manual Testing + Docs

Run through the full flow manually:
1. Register user → get API key
2. Create project
3. Create tasks in project
4. List tasks with filters
5. Update task (check version increment)
6. Soft delete task
7. Restore task
8. Verify audit logs

Update `apps/api/README.md` with new endpoints.

## Definition of Done

- All project and task endpoints work locally
- Soft deletes are reversible
- Version-based concurrency returns 409 on conflict
- Audit log entries exist for all mutations
- README updated with new endpoints
- Migration applies cleanly on fresh database

## Risk: D1 JSON querying

D1 supports `json_extract()` for the `metadata_json` column, but performance may vary. For Week 2, just store and return metadata as-is. Don't build metadata filtering yet — wait for a real use case from a design partner.
