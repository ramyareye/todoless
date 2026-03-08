# Todoless Setup And Flows

## Endpoints

- API: `https://todoless.dev`
- Hosted MCP: `https://mcp.todoless.dev/mcp`

## Bootstrap a user

Register:

```bash
curl -sS -X POST "https://todoless.dev/v1/auth/register" \
  -H "content-type: application/json" \
  -d '{"email":"founder@example.com","workspace_name":"Acme Ops"}'
```

Important response fields:

- `data.user.id`
- `data.user.email`
- `data.workspace.id`
- `data.workspace.name`
- `data.api_key`

Claim an invite:

```bash
curl -sS -X POST "https://todoless.dev/v1/auth/claim-invite" \
  -H "content-type: application/json" \
  -d '{"invite_token":"<invite_token>","display_name":"Jane Doe"}'
```

## Check current principal

```bash
curl -sS "https://todoless.dev/v1/me" \
  -H "authorization: Bearer $TODOLESS_API_KEY"
```

Current response shape:

```json
{
  "success": true,
  "data": {
    "user": {
      "id": "usr_...",
      "email": "founder@example.com"
    },
    "scopes": [
      "workspace:read",
      "workspace:write",
      "members:read",
      "members:write",
      "apikeys:write"
    ],
    "api_key_id": "key_..."
  }
}
```

## API patterns

List workspaces for the authenticated user:

```bash
curl -sS "https://todoless.dev/v1/workspaces?limit=20" \
  -H "authorization: Bearer $TODOLESS_API_KEY"
```

Create a project:

```bash
curl -sS -X POST "https://todoless.dev/v1/workspaces/$WORKSPACE_ID/projects" \
  -H "authorization: Bearer $TODOLESS_API_KEY" \
  -H "content-type: application/json" \
  -d '{"name":"Launch","description":"Q2 launch"}'
```

Create a task:

```bash
curl -sS -X POST "https://todoless.dev/v1/workspaces/$WORKSPACE_ID/tasks" \
  -H "authorization: Bearer $TODOLESS_API_KEY" \
  -H "content-type: application/json" \
  -d '{"title":"Ship landing page","project_id":"'$PROJECT_ID'","priority":"P1"}'
```

Update a task with optimistic concurrency:

```bash
curl -sS -X PATCH "https://todoless.dev/v1/tasks/$TASK_ID" \
  -H "authorization: Bearer $TODOLESS_API_KEY" \
  -H "content-type: application/json" \
  -H "if-match-version: $VERSION" \
  -d '{"status":"IN_PROGRESS","change_reason":"manual"}'
```

Read task history:

```bash
curl -sS "https://todoless.dev/v1/tasks/$TASK_ID/history?limit=20" \
  -H "authorization: Bearer $TODOLESS_API_KEY"
```

Add a workspace member:

```bash
curl -sS -X POST "https://todoless.dev/v1/workspaces/$WORKSPACE_ID/members" \
  -H "authorization: Bearer $TODOLESS_API_KEY" \
  -H "content-type: application/json" \
  -d '{"email":"jane@example.com","role":"MEMBER"}'
```

Important member-add response fields:

- `data.user_id`
- `data.invite_token`
- `data.invite_url`
- `data.invite_expires_at`

Remove a member and reassign their tasks:

```bash
curl -sS -X DELETE "https://todoless.dev/v1/workspaces/$WORKSPACE_ID/members/$USER_ID?task_policy=reassign&reassign_to_user_id=$REASSIGN_TO_USER_ID" \
  -H "authorization: Bearer $TODOLESS_API_KEY"
```

## Hosted MCP patterns

Recommended hosted setup:

- URL: `https://mcp.todoless.dev/mcp`
- Bearer token: the user's Todoless API key

If the client supports simple hosted MCP config:

```toml
[mcp_servers.todoless]
url = "https://mcp.todoless.dev/mcp"
bearer_token_env_var = "TODOLESS_API_KEY"
```

Behavior:

- each user sees only the workspaces they belong to
- no shared API key should be assumed

If `MCP_AUTH_TOKEN` is enabled on the server, the client must also send `x-todoless-api-key`. Many clients do not support that cleanly, so prefer the plain per-user bearer-token mode unless the deployment requires extra gateway auth.

## Local STDIO MCP patterns

Use local MCP when the AI client launches a local process.

```toml
[mcp_servers.todoless]
command = "bun"
args = ["run", "--cwd", "/absolute/path/to/todoless/apps/mcp-server", "start"]

[mcp_servers.todoless.env]
TODOLESS_API_BASE_URL = "https://todoless.dev"
TODOLESS_API_KEY = "tdls_live_..."
TODOLESS_WORKSPACE_ID = "ws_..."
```

Required env for local STDIO:

- `TODOLESS_API_KEY`

Optional:

- `TODOLESS_API_BASE_URL`
- `TODOLESS_WORKSPACE_ID`

## MCP tools

Current hosted/local MCP tools:

- `workspaces.list`
- `workspaces.get`
- `members.list`
- `members.add`
- `members.remove`
- `projects.list`
- `projects.create`
- `projects.get`
- `projects.update`
- `projects.delete`
- `tasks.list`
- `tasks.get`
- `tasks.history`
- `tasks.create`
- `tasks.update`
- `tasks.delete`
- `tasks.restore`

## Recommended integration decisions

For a product/backend integration:

- use the API first
- keep the personal key per user
- store workspace ids explicitly in your app

For an AI assistant:

- use hosted MCP if your client supports bearer auth
- use local STDIO MCP for local developer workflows
- bootstrap auth outside MCP

For multi-user SaaS:

- do not use one shared Todoless key for everyone
- do not mint one workspace-global key and pretend it is a user

## What not to assume

- Do not assume a user belongs to only one workspace.
- Do not assume tasks must belong to a project.
- Do not assume project-level membership exists.
- Do not assume MCP handles signup/login for you.
