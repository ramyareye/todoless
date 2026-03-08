# Todoless API (Foundation + Week-2 Core)

Worker-first API scaffold for the multi-tenant headless Todoless platform.

## What is included
- Cloudflare Worker + TypeScript + Hono
- D1 migrations for identity + projects/tasks/history primitives
- Personal and workspace-scoped API key auth with hashed key storage (`key_prefix` + `key_hash`)
- Optional Resend-powered invitation and welcome emails
- Workspace membership RBAC (`OWNER`, `ADMIN`, `MEMBER`, `VIEWER`)
- Secure endpoints for auth/workspaces/members/api keys/projects/tasks

## Endpoints
- `GET /v1/health`
- `POST /v1/auth/register`
- `POST /v1/auth/claim-invite`
- `GET /v1/me`
- `GET /v1/workspaces`
- `POST /v1/workspaces`
- `GET /v1/workspaces/:workspaceId`
- `GET /v1/workspaces/:workspaceId/members`
- `POST /v1/workspaces/:workspaceId/members`
- `DELETE /v1/workspaces/:workspaceId/members/:userId`
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
- `GET /v1/tasks/:taskId/history`
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

The response returns a personal API key once. Persist it securely. That key is user-based, so `/v1/workspaces` reflects the workspaces where that user has membership.

## Invited member claim flow
When an admin adds a member with `POST /v1/workspaces/:workspaceId/members`, the response includes a one-time `invite_token`.
It also includes `invite_url`, which can be sent directly to the user.

Redeem it to get that user's personal API key:
```bash
curl -s -X POST "http://localhost:8787/v1/auth/claim-invite" \
  -H "content-type: application/json" \
  -d '{"invite_token":"<invite_token>","display_name":"Jane Doe"}'
```

The claim response returns a personal API key once. Invite tokens are one-time and expire automatically.

## Email delivery
Optional env vars:
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- `RESEND_REPLY_TO_EMAIL`
- `APP_BASE_URL`

Behavior:
- `POST /v1/auth/register` queues a welcome email when Resend is configured.
- `POST /v1/workspaces/:workspaceId/members` queues an invite email when Resend is configured.
- `GET /accept-invite?token=...` serves a basic accept-invite page that redeems the token and shows the personal API key once.
- If `APP_BASE_URL` is set, email links point there.
- If `APP_BASE_URL` is not set, invite links fall back to the API-hosted accept page.

## Membership model
- Members are added to a workspace, not directly to a project.
- Projects and tasks inherit access from workspace membership.
- A task can be assigned to any current workspace member.
- A task can be reassigned later with `PATCH /v1/tasks/:taskId`.

## Task history
Task changes are stored in `task_history`, including:
- status changes
- assignee changes
- due date changes
- priority changes
- create, delete, and restore events

Query task history:
```bash
curl -s "$BASE_URL/v1/tasks/$TASK_ID/history?limit=20" \
  -H "authorization: Bearer $API_KEY"
```

## Remove a workspace member
Removing a member is workspace-level. If they still have assigned tasks, you must choose a task policy:

Unassign their active tasks:
```bash
curl -s -X DELETE "$BASE_URL/v1/workspaces/$WORKSPACE_ID/members/$USER_ID?task_policy=unassign" \
  -H "authorization: Bearer $API_KEY"
```

Reassign their active tasks:
```bash
curl -s -X DELETE "$BASE_URL/v1/workspaces/$WORKSPACE_ID/members/$USER_ID?task_policy=reassign&reassign_to_user_id=$REPLACEMENT_USER_ID" \
  -H "authorization: Bearer $API_KEY"
```

If the member still has assigned tasks and no policy is provided, the API returns `409 ASSIGNED_TASKS_EXIST`.

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
- Personal API keys are user-based (`workspace_id = NULL`) and can access any workspace where the user has membership.
- Workspace-scoped API keys can still be created via `POST /v1/workspaces/:workspaceId/api-keys` for restricted automation.
- Workspace authorization is enforced by both scopes and RBAC role checks.
- `POST /v1/auth/register` is rate-limited and returns `429 RATE_LIMITED` when exceeded.
- `POST /v1/auth/claim-invite` returns `409` when the invite token is expired, already claimed, or no longer valid.
- `DELETE /v1/workspaces/:workspaceId/members/:userId` returns `409 ASSIGNED_TASKS_EXIST` when the removed member still has active tasks and no reassignment policy is provided.
- JSON endpoints require `content-type: application/json` and return `415 INVALID_CONTENT_TYPE` otherwise.

## Next steps
- Add idempotency table + middleware
- Add change feed (`/sync`) and webhook outbox with queues
