# Todoless API (Foundation + Week-2 Core)

Worker-first API scaffold for the multi-tenant headless Todoless platform.

## What is included
- Cloudflare Worker + TypeScript + Hono
- D1 migrations for identity + projects/tasks/history primitives
- API key auth with hashed key storage (`key_prefix` + `key_hash`)
- Workspace membership RBAC (`OWNER`, `ADMIN`, `MEMBER`, `VIEWER`)
- Secure endpoints for auth/workspaces/members/api keys/projects/tasks

## Endpoints
- `GET /v1/health`
- `POST /v1/auth/register`
- `GET /v1/me`
- `GET /v1/workspaces`
- `POST /v1/workspaces`
- `GET /v1/workspaces/:workspaceId`
- `GET /v1/workspaces/:workspaceId/members`
- `POST /v1/workspaces/:workspaceId/members`
- `POST /v1/workspaces/:workspaceId/api-keys`
- `POST /v1/api-keys/:apiKeyId/revoke`
- `POST /v1/workspaces/:workspaceId/projects`
- `GET /v1/workspaces/:workspaceId/projects`
- `GET /v1/projects/:projectId`
- `PATCH /v1/projects/:projectId`
- `DELETE /v1/projects/:projectId`
- `POST /v1/workspaces/:workspaceId/tasks`
- `GET /v1/workspaces/:workspaceId/tasks`
- `GET /v1/tasks/:taskId`
- `PATCH /v1/tasks/:taskId`
- `DELETE /v1/tasks/:taskId`
- `POST /v1/tasks/:taskId/restore`

## Query pagination
- `GET /v1/workspaces` supports `limit` and `cursor`
- `GET /v1/workspaces/:workspaceId/members` supports `limit` and `cursor`
- `GET /v1/workspaces/:workspaceId/tasks` supports `limit` and `cursor` (plus filters)
- Responses include:
  - `pagination.limit`
  - `pagination.next_cursor`
  - `pagination.has_more`

## Local setup
1. Install dependencies
```bash
cd apps/api
bun install
```

2. Create D1 database
```bash
npx wrangler d1 create todoless
```
Update `database_id` in `apps/api/wrangler.toml`.

3. Configure local secrets
```bash
cp .dev.vars.example .dev.vars
```
Set `API_KEY_PEPPER` to a long random secret.

4. Apply migrations
```bash
bun run db:migrate:local
```

5. Run dev server
```bash
bun run dev
```

## Register flow example
```bash
curl -X POST http://localhost:8787/v1/auth/register \
  -H "content-type: application/json" \
  -d '{"email":"founder@example.com","workspace_name":"Acme Ops"}'
```

The response returns an API key once. Persist it securely.

## Smoke tests (copy/paste)
Run automated smoke flow (requires `bun run dev` running in another terminal):
```bash
bun run smoke
```

Run API behavior tests (authz + boundaries + pagination + content-type):
```bash
bun run test:api
```

Full validation checklist:
```bash
cat TEST_CHECKLIST.md
```

Or run manually:

Set common vars:
```bash
BASE_URL="http://localhost:8787"
API_KEY="<paste_api_key_from_register>"
WORKSPACE_ID="<workspace_id_from_register>"
```

Create project:
```bash
curl -s -X POST "$BASE_URL/v1/workspaces/$WORKSPACE_ID/projects" \
  -H "authorization: Bearer $API_KEY" \
  -H "content-type: application/json" \
  -d '{"name":"Product Launch","description":"Q1 launch plan"}'
```

List projects:
```bash
curl -s "$BASE_URL/v1/workspaces/$WORKSPACE_ID/projects" \
  -H "authorization: Bearer $API_KEY"
```

Set project id:
```bash
PROJECT_ID="<project_id_from_create_project>"
```

Create task:
```bash
curl -s -X POST "$BASE_URL/v1/workspaces/$WORKSPACE_ID/tasks" \
  -H "authorization: Bearer $API_KEY" \
  -H "content-type: application/json" \
  -d "{\"title\":\"Ship API\",\"project_id\":\"$PROJECT_ID\",\"priority\":\"P1\"}"
```

List tasks (with filters):
```bash
curl -s "$BASE_URL/v1/workspaces/$WORKSPACE_ID/tasks?status=TODO&priority=P1&limit=50" \
  -H "authorization: Bearer $API_KEY"
```

Set task id + version:
```bash
TASK_ID="<task_id_from_create_task>"
VERSION="<version_from_create_task>"
```

Update task with optimistic concurrency:
```bash
curl -s -X PATCH "$BASE_URL/v1/tasks/$TASK_ID" \
  -H "authorization: Bearer $API_KEY" \
  -H "content-type: application/json" \
  -H "if-match-version: $VERSION" \
  -d '{"status":"IN_PROGRESS","change_reason":"manual"}'
```

Soft delete and restore:
```bash
curl -s -X DELETE "$BASE_URL/v1/tasks/$TASK_ID" \
  -H "authorization: Bearer $API_KEY"

curl -s -X POST "$BASE_URL/v1/tasks/$TASK_ID/restore" \
  -H "authorization: Bearer $API_KEY"
```

## Security notes
- API keys are never stored plaintext.
- The `API_KEY_PEPPER` secret is mandatory.
- Workspace authorization is enforced by both scopes and RBAC role checks.
- `POST /v1/auth/register` is rate-limited and returns `429 RATE_LIMITED` when exceeded.
- JSON endpoints require `content-type: application/json` and return `415 INVALID_CONTENT_TYPE` otherwise.

## Next steps
- Add idempotency table + middleware
- Add change feed (`/sync`) and webhook outbox with queues
