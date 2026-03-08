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
assert_status 404 "non-member workspace access"

echo "[test-api] me shape"
http_call "$BASE_URL/v1/me" \
  -H "authorization: Bearer $API_KEY_A"
assert_status 200 "me"
assert_success "me"
ME_USER_ID="$(printf '%s' "$HTTP_BODY" | json_read 'data.data.user.id')"
ME_EMAIL="$(printf '%s' "$HTTP_BODY" | json_read 'data.data.user.email')"
if [[ -z "$ME_USER_ID" || "$ME_EMAIL" != "$EMAIL_A" ]]; then
  echo "[test-api] me shape failed: expected nested user payload for $EMAIL_A got $HTTP_BODY" >&2
  exit 1
fi

echo "[test-api] create members"
MEMBER1_INVITE_TOKEN=""
MEMBER1_USER_ID=""
MEMBER2_USER_ID=""
for i in 1 2; do
  MEMBER_EMAIL="member${i}+$(date +%s)@example.com"
  http_call -X POST "$BASE_URL/v1/workspaces/$WS_A/members" \
    -H "authorization: Bearer $API_KEY_A" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$MEMBER_EMAIL\",\"role\":\"MEMBER\"}"
  assert_status 201 "create member $i"
  assert_success "create member $i"
  if [[ "$i" == "1" ]]; then
    MEMBER1_USER_ID="$(printf '%s' "$HTTP_BODY" | json_read 'data.data.user_id')"
    MEMBER1_INVITE_TOKEN="$(printf '%s' "$HTTP_BODY" | json_read 'data.data.invite_token')"
  else
    MEMBER2_USER_ID="$(printf '%s' "$HTTP_BODY" | json_read 'data.data.user_id')"
  fi
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

echo "[test-api] claim member invite"
http_call -X POST "$BASE_URL/v1/auth/claim-invite" \
  -H 'content-type: application/json' \
  -d "{\"invite_token\":\"$MEMBER1_INVITE_TOKEN\",\"display_name\":\"Member One\"}"
assert_status 201 "claim member invite"
assert_success "claim member invite"
MEMBER1_KEY="$(printf '%s' "$HTTP_BODY" | json_read 'data.data.api_key')"

echo "[test-api] claim member invite twice"
http_call -X POST "$BASE_URL/v1/auth/claim-invite" \
  -H 'content-type: application/json' \
  -d "{\"invite_token\":\"$MEMBER1_INVITE_TOKEN\"}"
assert_status 409 "claim member invite twice"

echo "[test-api] member key sees own workspaces"
http_call "$BASE_URL/v1/workspaces?limit=10" \
  -H "authorization: Bearer $MEMBER1_KEY"
assert_status 200 "member workspaces"
assert_success "member workspaces"
CLAIMED_MEMBER_WORKSPACE_ID="$(printf '%s' "$HTTP_BODY" | json_read 'data.data.workspaces[0] ? data.data.workspaces[0].id : ""')"
if [[ "$CLAIMED_MEMBER_WORKSPACE_ID" != "$WS_A" ]]; then
  echo "[test-api] member workspaces failed: expected first workspace $WS_A got $CLAIMED_MEMBER_WORKSPACE_ID" >&2
  echo "[test-api] response: $HTTP_BODY" >&2
  exit 1
fi

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

echo "[test-api] create assigned task"
http_call -X POST "$BASE_URL/v1/workspaces/$WS_A/tasks" \
  -H "authorization: Bearer $API_KEY_A" \
  -H 'content-type: application/json' \
  -d "{\"title\":\"Assigned Task\",\"priority\":\"P1\",\"assignee_user_id\":\"$MEMBER1_USER_ID\"}"
assert_status 201 "create assigned task"
assert_success "create assigned task"
ASSIGNED_TASK_ID="$(printf '%s' "$HTTP_BODY" | json_read 'data.data.id')"
ASSIGNED_TASK_VERSION="$(printf '%s' "$HTTP_BODY" | json_read 'data.data.version')"

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

echo "[test-api] reassign assigned task"
http_call -X PATCH "$BASE_URL/v1/tasks/$ASSIGNED_TASK_ID" \
  -H "authorization: Bearer $API_KEY_A" \
  -H 'content-type: application/json' \
  -H "if-match-version: $ASSIGNED_TASK_VERSION" \
  -d "{\"assignee_user_id\":\"$MEMBER2_USER_ID\",\"change_reason\":\"manual\"}"
assert_status 200 "task reassign"
assert_success "task reassign"
REASSIGNED_TASK_VERSION="$(printf '%s' "$HTTP_BODY" | json_read 'data.data.version')"

echo "[test-api] task history"
http_call "$BASE_URL/v1/tasks/$ASSIGNED_TASK_ID/history?limit=10" \
  -H "authorization: Bearer $API_KEY_A"
assert_status 200 "task history"
assert_success "task history"
printf '%s' "$HTTP_BODY" | json_read 'data.data.history.find((entry) => entry.change_type === "ASSIGNEE_CHANGED") ? "ok" : undefined' >/dev/null

echo "[test-api] create removable member task"
http_call -X PATCH "$BASE_URL/v1/tasks/$ASSIGNED_TASK_ID" \
  -H "authorization: Bearer $API_KEY_A" \
  -H 'content-type: application/json' \
  -H "if-match-version: $REASSIGNED_TASK_VERSION" \
  -d "{\"assignee_user_id\":\"$MEMBER1_USER_ID\",\"change_reason\":\"manual\"}"
assert_status 200 "task assign back to removable member"
assert_success "task assign back to removable member"

echo "[test-api] member removal blocked while tasks assigned"
http_call -X DELETE "$BASE_URL/v1/workspaces/$WS_A/members/$MEMBER1_USER_ID" \
  -H "authorization: Bearer $API_KEY_A"
assert_status 409 "member removal blocked"

echo "[test-api] remove member with reassignment"
http_call -X DELETE "$BASE_URL/v1/workspaces/$WS_A/members/$MEMBER1_USER_ID?task_policy=reassign&reassign_to_user_id=$MEMBER2_USER_ID" \
  -H "authorization: Bearer $API_KEY_A"
assert_status 200 "member removal with reassignment"
assert_success "member removal with reassignment"

echo "[test-api] removed member loses workspace access"
http_call "$BASE_URL/v1/workspaces/$WS_A" \
  -H "authorization: Bearer $MEMBER1_KEY"
assert_status 404 "removed member workspace access"

echo "[test-api] reassigned task visible after member removal"
http_call "$BASE_URL/v1/tasks/$ASSIGNED_TASK_ID" \
  -H "authorization: Bearer $API_KEY_A"
assert_status 200 "reassigned task fetch"
assert_success "reassigned task fetch"
FINAL_ASSIGNEE_USER_ID="$(printf '%s' "$HTTP_BODY" | json_read 'data.data.assignee_user_id')"
if [[ "$FINAL_ASSIGNEE_USER_ID" != "$MEMBER2_USER_ID" ]]; then
  echo "[test-api] reassigned task fetch failed: expected assignee $MEMBER2_USER_ID got $FINAL_ASSIGNEE_USER_ID" >&2
  echo "[test-api] response: $HTTP_BODY" >&2
  exit 1
fi

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
