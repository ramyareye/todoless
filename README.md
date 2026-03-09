# Todoless

Headless task infrastructure for SaaS products and internal operations.

## Project layout

- `apps/api` - production API (Cloudflare Worker + Hono + D1)
- `apps/mcp-server` - MCP adapter for Codex/ChatGPT tools (workspaces, members, projects, tasks)
- `TASKS.md` - current implementation checklist
- `licensing-strategy.md` - OSS + SaaS licensing model
- `LICENSE` - Apache-2.0 license text
- `TRADEMARKS.md` - trademark usage policy
- `docs` - decisions, planning, reviews, research, and archived prototype

## Quick start (API foundation)

```bash
cd apps/api
bun install
cp .dev.vars.example .dev.vars
# set API_KEY_PEPPER in .dev.vars
npx wrangler d1 create todoless
# update database_id in wrangler.toml
bun run db:migrate:local
bun run dev
```

See `apps/api/README.md` for endpoint details.

## MCP first run (Codex + production)

Copy/paste this once:

```bash
set -euo pipefail

BASE_URL="https://todoless.dev"
REPO_DIR="$PWD"
EMAIL="codex-mcp+$(date +%s)@example.com"

REGISTER="$(curl -sS -X POST "$BASE_URL/v1/auth/register" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"workspace_name\":\"Todoless MCP\"}")"

WORKSPACE_ID="$(printf '%s' "$REGISTER" | bun -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync(0,'utf8'));if(!d.success){console.error(JSON.stringify(d));process.exit(1)}process.stdout.write(d.data.workspace.id)")"

echo "Registration created workspace_id=$WORKSPACE_ID"
echo "Verify the email you just received, then copy the personal API key shown by the verification page."
echo "Set PERSONAL_KEY manually before continuing."
exit 0
```

Then continue:

```bash
BASE_URL="https://todoless.dev"
REPO_DIR="$PWD"
WORKSPACE_ID="<workspace_id_from_register>"
PERSONAL_KEY="<personal_api_key_from_verify_email_page>"

CONFIG="$HOME/.codex/config.toml"
mkdir -p "$(dirname "$CONFIG")"
touch "$CONFIG"

if rg -q '^\[mcp_servers\.todoless\]' "$CONFIG"; then
  perl -0pe 's/TODOLESS_API_BASE_URL\s*=\s*"[^"]*"/TODOLESS_API_BASE_URL = "'"$BASE_URL"'"/g; s/TODOLESS_API_KEY\s*=\s*"[^"]*"/TODOLESS_API_KEY = "'"$PERSONAL_KEY"'"/g; s/TODOLESS_WORKSPACE_ID\s*=\s*"[^"]*"/TODOLESS_WORKSPACE_ID = "'"$WORKSPACE_ID"'"/g' "$CONFIG" > "$CONFIG.tmp"
  mv "$CONFIG.tmp" "$CONFIG"
else
  cat >> "$CONFIG" <<EOF

[mcp_servers.todoless]
command = "bun"
args = ["run", "--cwd", "$REPO_DIR/apps/mcp-server", "start"]

[mcp_servers.todoless.env]
TODOLESS_API_BASE_URL = "$BASE_URL"
TODOLESS_API_KEY = "$PERSONAL_KEY"
TODOLESS_WORKSPACE_ID = "$WORKSPACE_ID"
EOF
fi

cd "$REPO_DIR/apps/mcp-server"
bun install
TODOLESS_API_BASE_URL="$BASE_URL" TODOLESS_API_KEY="$PERSONAL_KEY" bun run validate

echo "Done."
echo "workspace_id=$WORKSPACE_ID"
echo "Restart Codex to load MCP config."
```
