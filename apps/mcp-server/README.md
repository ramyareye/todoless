# Todoless MCP Adapter

Todoless MCP adapter for Codex/ChatGPT.

Supports two run modes:
- Local `STDIO` (`src/server.mjs`)
- Hosted `Streamable HTTP` on Cloudflare Workers (`src/worker.mjs`)

## Tools exposed
- `projects.list`
- `tasks.list`
- `tasks.create`
- `tasks.update`

## Env vars
- `TODOLESS_API_BASE_URL` (default: `https://todoless-api.formahsa.workers.dev`)
- `TODOLESS_API_KEY`
  - local `STDIO`: required; use that user's scoped key
  - hosted HTTP worker: optional fallback only; if omitted, each request must provide a user API key
- `TODOLESS_WORKSPACE_ID` (optional convenience in prompts/scripts)
- `MCP_AUTH_TOKEN` (optional; protects hosted `/mcp` endpoint)

## First run (recommended)
Use the one-block setup in root `README.md` under `MCP first run (Codex + production)`.

## Local STDIO mode (existing)
```bash
cd apps/mcp-server
bun install
TODOLESS_API_KEY="<your_api_key>" bun run start
```

Codex `config.toml`:
```toml
[mcp_servers.todoless]
command = "bun"
args = ["run", "--cwd", "<repo_path>/apps/mcp-server", "start"]

[mcp_servers.todoless.env]
TODOLESS_API_BASE_URL = "https://todoless-api.formahsa.workers.dev"
TODOLESS_API_KEY = "<your_api_key>"
TODOLESS_WORKSPACE_ID = "<your_workspace_id>"
```

## Cloudflare Streamable HTTP mode (new)
This removes local working-directory dependency in client apps.

### 1) Configure secrets
```bash
cd apps/mcp-server
bun install

# optional fallback only; if set, the worker can act as a shared service identity
bunx wrangler secret put TODOLESS_API_KEY

# optional: protects MCP endpoint
bunx wrangler secret put MCP_AUTH_TOKEN
```

For local worker dev:
```bash
cp .dev.vars.example .dev.vars
# fill MCP_AUTH_TOKEN if using it
# fill TODOLESS_API_KEY only if you want a shared fallback identity
bun run dev:http
```

### 2) Deploy MCP worker
```bash
cd apps/mcp-server
bun run deploy:http
```

This creates:
- health: `https://<worker>.workers.dev/health`
- mcp: `https://<worker>.workers.dev/mcp`

### 3) Connect in custom MCP UI (Streamable HTTP)
Recommended per-user mode:
- Name: `todoless_grow_http`
- URL: `https://<worker>.workers.dev/mcp`
- Do not set `MCP_AUTH_TOKEN`
- Set Bearer/Auth token to that user's Todoless API key

Result:
- each user sees only their own workspaces through the API's membership checks

If `MCP_AUTH_TOKEN` is enabled:
- Bearer/Auth token must be `<MCP_AUTH_TOKEN>`
- Send `x-todoless-api-key: <user_todoless_api_key>` on each request
- If your MCP client cannot send custom headers, do not enable `MCP_AUTH_TOKEN` for per-user mode
- `TODOLESS_API_KEY` can still be configured as a shared fallback, but then the worker acts with that shared identity

### 4) Codex `config.toml` (hosted mode)
```toml
[mcp_servers.todoless_grow_http]
url = "https://<worker>.workers.dev/mcp"
bearer_token_env_var = "TODOLESS_API_KEY"
```

This hosted config is per-user when `TODOLESS_API_KEY` in the client environment belongs to that user.

If you enable `MCP_AUTH_TOKEN`, the client must also send `x-todoless-api-key`, which many MCP clients do not support directly.

## Validate adapter (Bun)
End-to-end check against deployed Todoless API:
```bash
cd apps/mcp-server
bun run validate
```
