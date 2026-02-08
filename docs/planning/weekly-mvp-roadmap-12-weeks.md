# Todoless 12-Week MVP Roadmap (Side Job)

## Scope
- Time budget: 6 to 8 hours per week.
- Goal: ship a paid-ready MVP in 12 weeks.
- Rule: one primary outcome per week.

## Weekly Plan

| Week | Focus | Build Scope (6-8h) | Done When |
|---|---|---|---|
| 1 | Environment lock-in | Finalize Worker + D1 local setup, migration flow, env secrets | Local dev setup works from clean clone |
| 2 | Data model MVP | Add `projects`, `tasks`, `task_labels` schema | Migrations apply cleanly and rollback plan documented |
| 3 | Task CRUD v1 | Create/list/get/update task endpoints | Endpoints pass manual API checks |
| 4 | Query essentials | Filters (`status`, `priority`, `project`), sorting, cursor pagination | `GET /tasks` supports production-like querying |
| 5 | Auth hardening | API key scopes matrix + key revoke/rotate polish | Scope enforcement verified on all task/project endpoints |
| 6 | Safety model | Soft delete + restore + audit write for task actions | Delete is reversible and auditable |
| 7 | Webhooks v1 | Event outbox + `task.created/updated/deleted` contracts | Event rows emitted for all task mutations |
| 8 | Reliable delivery | Queue consumer + retry/backoff + delivery logs | Failed webhooks retry and are visible in logs |
| 9 | API DX | OpenAPI spec + consistent error codes + request IDs | API contract is exportable and stable |
| 10 | SDK alpha | Minimal TypeScript SDK (`auth`, `tasks.list/create/update`) | Example app/script uses SDK end-to-end |
| 11 | Billing minimum | Stripe customer/workspace mapping + plan entitlements (Free/Pro) | Feature gates enforced by plan flags |
| 12 | Launch candidate | Docs polish, quickstart flow, pricing page copy, beta onboarding | 2-3 design partners can onboard without hand-holding |

## Weekly Rhythm
- Session 1 (1.5-2h): implement core changes.
- Session 2 (1.5-2h): finish feature + tests.
- Session 3 (1.5-2h): docs + release note + cleanup.
- Buffer (1-2h): spillover or bug fixes.

## Non-Negotiables
- No new feature if previous week is incomplete.
- Every endpoint change updates docs.
- Every mutating endpoint has auth + authorization check.
- Keep observability basic but consistent (`request_id`, error code, status).

## MVP Launch Exit Criteria (end of Week 12)
- Task API is stable for one real integration.
- Webhooks are reliable enough for production beta (retry + logs).
- One SDK path works cleanly (TypeScript).
- Free/Pro gating is functional.
- At least 2 design partners actively testing.

## Fast Fallback Rule
If a week slips, cut scope using this order:
1. Keep API correctness.
2. Keep auth/security.
3. Defer UX polish and non-critical dashboard work.

