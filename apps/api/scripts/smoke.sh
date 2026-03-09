#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8787}"
BASE_URL="${BASE_URL%/}"

json_read() {
  local expr="$1"
  bun -e "
const fs = require('fs');
const input = fs.readFileSync(0, 'utf8');
const data = JSON.parse(input);
const val = (function(){ return ${expr}; })();
if (val === undefined || val === null) process.exit(2);
if (typeof val === 'object') { console.log(JSON.stringify(val)); } else { console.log(String(val)); }
"
}

require_success() {
  local payload="$1"
  local label="$2"
  if ! printf '%s' "$payload" | bun -e "
const fs = require('fs');
const input = fs.readFileSync(0, 'utf8');
const data = JSON.parse(input);
if (data && data.success === true) process.exit(0);
process.exit(1);
"; then
    echo \"[smoke] $label failed\" >&2
    echo \"[smoke] response: $payload\" >&2
    exit 1
  fi
}

request() {
  curl -sS "$@"
}

echo "[smoke] checking health at $BASE_URL/v1/health"
request "$BASE_URL/v1/health" >/dev/null

EMAIL="founder+$(date +%s)@example.com"
echo "[smoke] register: $EMAIL"
register_response="$(request -X POST "$BASE_URL/v1/auth/register" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"workspace_name\":\"Acme Ops\"}")"
require_success "$register_response" "register"

WORKSPACE_ID="$(printf '%s' "$register_response" | json_read 'data.data.workspace.id')"
VERIFY_TOKEN="$(printf '%s' "$register_response" | json_read 'data.data.verification_token')"

echo "[smoke] verify email"
verify_response="$(request -X POST "$BASE_URL/v1/auth/verify-email" \
  -H 'content-type: application/json' \
  -d "{\"verification_token\":\"$VERIFY_TOKEN\"}")"
require_success "$verify_response" "verify email"
API_KEY="$(printf '%s' "$verify_response" | json_read 'data.data.api_key')"

echo "[smoke] create project"
project_response="$(request -X POST "$BASE_URL/v1/workspaces/$WORKSPACE_ID/projects" \
  -H "authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{"name":"Product Launch","description":"Q1 launch plan"}')"
require_success "$project_response" "create project"
PROJECT_ID="$(printf '%s' "$project_response" | json_read 'data.data.id')"

echo "[smoke] create task"
task_response="$(request -X POST "$BASE_URL/v1/workspaces/$WORKSPACE_ID/tasks" \
  -H "authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d "{\"title\":\"Ship API\",\"project_id\":\"$PROJECT_ID\",\"priority\":\"P1\"}")"
require_success "$task_response" "create task"
TASK_ID="$(printf '%s' "$task_response" | json_read 'data.data.id')"
VERSION="$(printf '%s' "$task_response" | json_read 'data.data.version')"

echo "[smoke] patch task (version=$VERSION)"
patched_response="$(request -X PATCH "$BASE_URL/v1/tasks/$TASK_ID" \
  -H "authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -H "if-match-version: $VERSION" \
  -d '{"status":"IN_PROGRESS","change_reason":"manual"}')"
require_success "$patched_response" "patch task"
NEW_VERSION="$(printf '%s' "$patched_response" | json_read 'data.data.version')"

echo "[smoke] delete task"
delete_response="$(request -X DELETE "$BASE_URL/v1/tasks/$TASK_ID" \
  -H "authorization: Bearer $API_KEY")"
require_success "$delete_response" "delete task"

echo "[smoke] restore task"
restore_response="$(request -X POST "$BASE_URL/v1/tasks/$TASK_ID/restore" \
  -H "authorization: Bearer $API_KEY")"
require_success "$restore_response" "restore task"

echo "[smoke] list tasks"
list_response="$(request "$BASE_URL/v1/workspaces/$WORKSPACE_ID/tasks?limit=10" \
  -H "authorization: Bearer $API_KEY")"
require_success "$list_response" "list tasks"

echo "[smoke] success"
echo "workspace_id=$WORKSPACE_ID"
echo "project_id=$PROJECT_ID"
echo "task_id=$TASK_ID"
echo "task_version_after_patch=$NEW_VERSION"
