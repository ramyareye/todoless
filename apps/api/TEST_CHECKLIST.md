# API Test Checklist

Run with local dev server active (`npm run dev`).

## 1. Baseline
- [ ] `npm run typecheck` passes
- [ ] `npm run db:migrate:local` applies `0001` through `0004`
- [ ] `npm run smoke` finishes successfully

## 2. Auth and identity
- [ ] `POST /v1/auth/register` returns user, workspace, one-time API key
- [ ] `POST /v1/auth/claim-invite` redeems a one-time invite token for a personal API key
- [ ] `GET /v1/me` works with key
- [ ] Invalid/missing bearer token returns `401`
- [ ] Revoked key returns `401`

## 3. Workspace and membership
- [ ] `GET /v1/workspaces` returns user workspaces
- [ ] `POST /v1/workspaces` creates workspace
- [ ] `POST /v1/workspaces/:id/members` adds member
- [ ] Member add response includes one-time `invite_token`
- [ ] `DELETE /v1/workspaces/:id/members/:userId` blocks removal while tasks are assigned unless a task policy is provided
- [ ] Member removal can unassign or reassign active tasks
- [ ] ADMIN cannot assign role higher than self
- [ ] OWNER role cannot be modified

## 4. API key controls
- [ ] `POST /v1/workspaces/:id/api-keys` creates scoped key
- [ ] Scoped key cannot access another workspace (`403`)
- [ ] `POST /v1/api-keys/:id/revoke` revokes key

## 5. Project endpoints
- [ ] Create project
- [ ] List projects
- [ ] Get project by id
- [ ] Patch project fields
- [ ] Delete project (soft delete)
- [ ] `include_deleted=true` requires ADMIN+

## 6. Task endpoints
- [ ] Create task
- [ ] List tasks with filters (`status`, `priority`, `project_id`, `assignee_id`, `due_from`, `due_to`)
- [ ] Get task by id
- [ ] Get task history by id
- [ ] Patch task with version check succeeds
- [ ] Patch task with stale version returns `409 VERSION_CONFLICT`
- [ ] Delete task (soft)
- [ ] Restore task requires ADMIN+

## 7. History and audit
- [ ] `task_history` rows exist for create/update/delete/restore
- [ ] `project_history` rows exist for create/update/delete
- [ ] `audit_logs` rows exist for mutating operations

## 8. Multi-tenant boundary checks
- [ ] Workspace A key cannot read/write Workspace B resources
- [ ] Cross-workspace project/task ids are rejected

## 9. Production readiness gate
- [ ] Add pagination (`workspaces`, `members`, `tasks`)
- [ ] Add register rate limiting
- [ ] Add minimal automated tests in CI
- [ ] Add `LICENSE` + `TRADEMARKS.md`
