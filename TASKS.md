# Todoless Tasks

## Now (Week 2)
- [x] Add migration `0002_projects_tasks_and_history.sql` with `projects`, `tasks`, `labels`, `task_labels`
- [x] Add project endpoints (`create`, `list`, `get`, `update`, `delete` soft)
- [x] Add task endpoints (`create`, `list`, `get`, `update`, `delete`, `restore`)
- [x] Add optimistic concurrency for task update (`version` check)
- [x] Add task list filters (`status`, `priority`, `project_id`, `assignee_id`, due window)
- [x] Add audit log entries for mutations
- [x] Add task/project history tables + write paths
- [x] Refactor API into route/middleware/service modules
- [x] Update `apps/api/README.md` endpoint docs and smoke flow
- [x] Add automated local smoke script (`npm run smoke`)

## Next (Week 3)
- [x] Add pagination for `workspaces`, `members`, and `tasks`
- [x] Add rate limiting for `POST /v1/auth/register`
- [x] Add member invite claim flow for personal user API keys
- [x] Add safe workspace member removal with task reassignment/unassignment policy
- [ ] Tighten request content-type validation in JSON body parser
- [ ] Add minimal API test suite (happy-path + authz + boundary checks)

## Hardening
- [x] Add CI workflow (`typecheck` + tests)
- [x] Add `LICENSE` and `TRADEMARKS.md`

## Product Idea: Timeline + Change History
- [x] Add `task_history` / `project_history` events table (status, priority, due date, assignee changes)
- [x] Add API to query task change history
- [ ] Add deadline-aware planner endpoint to rebalance task timelines when dates or priorities change
- [ ] Store change reasons (`manual`, `deadline_shift`, `dependency_blocked`) for traceability
- [ ] Add API to query project timeline snapshots and "why did this move?" history

## Product Model Follow-ups
- [ ] Decide whether project-level membership/permissions are needed beyond workspace membership

## Pre-MCP and Production
- [ ] Run full checklist in `apps/api/TEST_CHECKLIST.md`
- [x] Add stable base URL (Cloudflare deploy) and verify smoke flow against it
- [x] Define MCP tool surface (`tasks.list`, `tasks.create`, `tasks.update`, `projects.list`) and scopes
- [x] Add MCP adapter/service endpoint (`apps/mcp-server`)
- [x] Validate MCP adapter from Codex
- [x] Expand MCP tool surface for day-to-day AI use (`workspaces.list`, `tasks.get`, `tasks.history`, `members.list`, `members.remove`)
- [x] Improve token DX for invited users (self-serve claim UI or delivery flow instead of manual invite token handoff)
- [x] Add optional welcome/invite email delivery hooks with Resend
