#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8787}"
BASE_URL="${BASE_URL%/}"

HTTP_STATUS=""
HTTP_BODY=""

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

http_call() {
  local tmp
  tmp="$(mktemp)"
  HTTP_STATUS="$(curl -sS -o "$tmp" -w '%{http_code}' "$@")"
  HTTP_BODY="$(cat "$tmp")"
  rm -f "$tmp"
}

assert_status() {
  local expected="$1"
  local label="$2"
  if [[ "$HTTP_STATUS" != "$expected" ]]; then
    echo "[test-api] $label failed: expected $expected got $HTTP_STATUS" >&2
    echo "[test-api] response: $HTTP_BODY" >&2
    exit 1
  fi
}

assert_success() {
  local label="$1"
  if ! printf '%s' "$HTTP_BODY" | bun -e "
const fs = require('fs');
const data = JSON.parse(fs.readFileSync(0, 'utf8'));
if (data && data.success === true) process.exit(0);
process.exit(1);
"; then
    echo "[test-api] $label did not return success=true" >&2
    echo "[test-api] response: $HTTP_BODY" >&2
    exit 1
  fi
}

echo "[test-api] health"
http_call "$BASE_URL/v1/health"
assert_status 200 "health"

BAD_EMAIL="bad+$(date +%s)@example.com"
echo "[test-api] register content-type enforcement"
http_call -X POST "$BASE_URL/v1/auth/register" \
  -H 'content-type: text/plain' \
  --data "{\"email\":\"$BAD_EMAIL\"}"
assert_status 415 "register invalid content-type"

EMAIL_A="suite-a+$(date +%s)@example.com"
echo "[test-api] register A"
http_call -X POST "$BASE_URL/v1/auth/register" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL_A\",\"workspace_name\":\"Suite A\"}"
assert_status 201 "register A"
assert_success "register A"
API_KEY_A="$(printf '%s' "$HTTP_BODY" | json_read 'data.data.api_key')"
WS_A="$(printf '%s' "$HTTP_BODY" | json_read 'data.data.workspace.id')"

EMAIL_B="suite-b+$(date +%s)@example.com"
echo "[test-api] register B"
http_call -X POST "$BASE_URL/v1/auth/register" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL_B\",\"workspace_name\":\"Suite B\"}"
assert_status 201 "register B"
assert_success "register B"
WS_B="$(printf '%s' "$HTTP_BODY" | json_read 'data.data.workspace.id')"

echo "[test-api] workspace boundary"
http_call "$BASE_URL/v1/workspaces/$WS_B" \
  -H "authorization: Bearer $API_KEY_A"
assert_status 403 "cross-workspace access"

echo "[test-api] create members"
for i in 1 2; do
  MEMBER_EMAIL="member${i}+$(date +%s)@example.com"
  http_call -X POST "$BASE_URL/v1/workspaces/$WS_A/members" \
    -H "authorization: Bearer $API_KEY_A" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$MEMBER_EMAIL\",\"role\":\"MEMBER\"}"
  assert_status 201 "create member $i"
  assert_success "create member $i"
done

echo "[test-api] members pagination"
http_call "$BASE_URL/v1/workspaces/$WS_A/members?limit=1" \
  -H "authorization: Bearer $API_KEY_A"
assert_status 200 "members list page 1"
assert_success "members list page 1"
MEMBERS_CURSOR="$(printf '%s' "$HTTP_BODY" | json_read 'data.data.pagination.next_cursor')"
http_call "$BASE_URL/v1/workspaces/$WS_A/members?limit=1&cursor=$MEMBERS_CURSOR" \
  -H "authorization: Bearer $API_KEY_A"
assert_status 200 "members list page 2"
assert_success "members list page 2"

echo "[test-api] create tasks"
for i in 1 2; do
  http_call -X POST "$BASE_URL/v1/workspaces/$WS_A/tasks" \
    -H "authorization: Bearer $API_KEY_A" \
    -H 'content-type: application/json' \
    -d "{\"title\":\"Suite Task $i\",\"priority\":\"P1\"}"
  assert_status 201 "create task $i"
  assert_success "create task $i"
  if [[ "$i" == "1" ]]; then
    TASK_ID="$(printf '%s' "$HTTP_BODY" | json_read 'data.data.id')"
    VERSION_1="$(printf '%s' "$HTTP_BODY" | json_read 'data.data.version')"
  fi
done

echo "[test-api] optimistic concurrency success"
http_call -X PATCH "$BASE_URL/v1/tasks/$TASK_ID" \
  -H "authorization: Bearer $API_KEY_A" \
  -H 'content-type: application/json' \
  -H "if-match-version: $VERSION_1" \
  -d '{"status":"IN_PROGRESS"}'
assert_status 200 "task update fresh version"
assert_success "task update fresh version"

echo "[test-api] optimistic concurrency conflict"
http_call -X PATCH "$BASE_URL/v1/tasks/$TASK_ID" \
  -H "authorization: Bearer $API_KEY_A" \
  -H 'content-type: application/json' \
  -H "if-match-version: $VERSION_1" \
  -d '{"status":"DONE"}'
assert_status 409 "task update stale version"

echo "[test-api] tasks pagination"
http_call "$BASE_URL/v1/workspaces/$WS_A/tasks?limit=1" \
  -H "authorization: Bearer $API_KEY_A"
assert_status 200 "tasks list page 1"
assert_success "tasks list page 1"
TASKS_CURSOR="$(printf '%s' "$HTTP_BODY" | json_read 'data.data.pagination.next_cursor')"
http_call "$BASE_URL/v1/workspaces/$WS_A/tasks?limit=1&cursor=$TASKS_CURSOR" \
  -H "authorization: Bearer $API_KEY_A"
assert_status 200 "tasks list page 2"
assert_success "tasks list page 2"

echo "[test-api] workspace list pagination metadata"
http_call "$BASE_URL/v1/workspaces?limit=10" \
  -H "authorization: Bearer $API_KEY_A"
assert_status 200 "workspaces list"
assert_success "workspaces list"
printf '%s' "$HTTP_BODY" | json_read 'data.data.pagination.limit' >/dev/null

echo "[test-api] success"
