# What to Build Next (Prioritized)

## The Situation

Week 1 is done: you have auth, workspaces, memberships, API keys, and audit logging on Cloudflare Workers + D1. The foundation is solid. Now you need to build the thing people will actually pay for.

## Priority 1: Projects + Tasks (Week 2 — do this now)

This is the core product. Without it, Todoless is an auth system with no purpose.

### Migration: `0002_projects_tasks.sql`

Tables to add:
- `projects` — workspace-scoped, with name, description, visibility, soft delete
- `tasks` — workspace + project scoped, with title, description, status, priority, assignee, due date, metadata JSON, version (for optimistic concurrency), soft delete
- `task_labels` — join table for many-to-many task/label relationship
- `labels` — workspace-scoped label definitions with color

### Endpoints to implement:

```
POST   /v1/workspaces/:wsId/projects
GET    /v1/workspaces/:wsId/projects
GET    /v1/projects/:projectId
PATCH  /v1/projects/:projectId
DELETE /v1/projects/:projectId           (soft delete)

POST   /v1/workspaces/:wsId/tasks
GET    /v1/workspaces/:wsId/tasks        (with filters: status, priority, project, label, assignee, due range)
GET    /v1/tasks/:taskId
PATCH  /v1/tasks/:taskId                 (with version check)
DELETE /v1/tasks/:taskId                 (soft delete)
POST   /v1/tasks/:taskId/restore
```

### Key design decisions:
- Status enum: `TODO`, `IN_PROGRESS`, `DONE`, `ARCHIVED`
- Priority enum: `P0`, `P1`, `P2`, `P3`
- `metadata` as a JSON column — lets customers attach arbitrary structured data without schema changes
- `version` column for optimistic concurrency — increment on every update, reject stale writes with 409

### Time estimate: 6-8 hours (one week)

## Priority 2: Cursor Pagination + Filtering (Week 3)

The prototype used offset pagination. The production API must use cursor pagination from day one.

- Cursor = `updated_at` + `id` composite (stable sort, no skipping)
- Response format: `{ data: [...], meta: { next_cursor, has_more } }`
- Filters: `?status=TODO&priority=P1&project_id=prj_123&assignee_id=usr_456&due_from=2026-02-01&due_to=2026-02-28`
- Full-text search: `?q=onboarding` (use D1's LIKE for now, consider FTS later)

### Time estimate: 4-6 hours

## Priority 3: Smoke Tests (Week 3, parallel)

Before adding more features, add automated endpoint tests. Use Vitest + the Wrangler unstable_dev API to spin up a local worker and hit real endpoints.

Test cases:
- Register → get API key → use key → CRUD workspace → CRUD project → CRUD task
- Expired key rejected
- Revoked key rejected
- Wrong workspace returns 404
- Viewer can't create tasks
- Member can't add members

### Time estimate: 3-4 hours

## Priority 4: Code Structure Split (Week 3, parallel)

Split `index.ts` into the module structure described in the code review. Do this BEFORE adding more endpoints, not after — it's much easier to move 840 lines than 2,500.

### Time estimate: 2-3 hours

## Priority 5: Webhooks + Event Outbox (Week 4-5)

This is where Todoless becomes more than a CRUD API.

- `change_log` table — every task mutation writes an event row in the same transaction
- `webhook_endpoints` table — workspace-scoped, with event subscriptions
- `webhook_deliveries` table — delivery attempts with status, response, retry info
- Queue consumer using Cloudflare Queues for async delivery
- HMAC-SHA256 signature on payloads
- Exponential backoff: 10s, 60s, 5m, 30m, 2h

### Time estimate: 10-14 hours (2 weeks)

## Priority 6: Sync Endpoint (Week 6)

- `GET /v1/workspaces/:wsId/sync?cursor=<sequence>&limit=1000`
- Returns: `{ upserts: [...], deletes: [...], next_cursor, has_more }`
- Uses the same `change_log` table from the webhook system
- This is the differentiator — most competitors don't offer delta sync

### Time estimate: 4-6 hours

## What NOT to build yet

- Dashboard UI (wait until API is stable and you have paying users)
- TypeScript SDK (wait until API surface is frozen)
- Stripe billing (wait until you have 2-3 design partners)
- AI features (post-MVP, not a differentiator for early adopters)
- GraphQL (premature optimization — REST is fine for v1)
- SSO/SAML (enterprise feature, not MVP)
