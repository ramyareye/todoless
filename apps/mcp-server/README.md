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
- `TODOLESS_API_KEY` (required; use a scoped key)
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

# required
bunx wrangler secret put TODOLESS_API_KEY

# optional (recommended): protects MCP endpoint
bunx wrangler secret put MCP_AUTH_TOKEN
```

For local worker dev:
```bash
cp .dev.vars.example .dev.vars
# fill TODOLESS_API_KEY (and MCP_AUTH_TOKEN if using it)
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
Use:
- Name: `todoless_grow_http`
- URL: `https://<worker>.workers.dev/mcp`
- Bearer/Auth token: `<MCP_AUTH_TOKEN>` (only if configured)

### 4) Codex `config.toml` (hosted mode)
```toml
[mcp_servers.todoless_grow_http]
url = "https://<worker>.workers.dev/mcp"
bearer_token_env_var = "TODOLESS_MCP_AUTH_TOKEN" # only if MCP_AUTH_TOKEN is enabled
```

If you do not set `MCP_AUTH_TOKEN`, omit `bearer_token_env_var`.

## Validate adapter (Bun)
End-to-end check against deployed Todoless API:
```bash
cd apps/mcp-server
bun run validate
```
