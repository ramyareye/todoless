# Todoless: Headless To-Do SaaS Blueprint

## 0) Baseline From Current Files

Current prototype strengths:
- `files/server.js` already has a working API with workspaces, todos, tags, and webhooks.
- `files/README.md` already documents a clean API surface for early testing.
- `files/headless-todo-demo.jsx` already proves the headless consumption model.

Current production gaps to close:
- API keys are stored in plaintext (`files/server.js:32`, `files/server.js:105`), not hashed.
- Multi-tenancy is "single-owner workspace", not team RBAC (`files/server.js:36`, `files/server.js:39`).
- Webhooks are sent inline on request path with no durable retries/DLQ (`files/server.js:127`, `files/server.js:143`).
- Pagination is offset-based (`files/server.js:323`), not cursor-based for large datasets.
- Hard deletes are used for todos/workspaces (`files/server.js:471`, `files/server.js:280`), no sync tombstones.
- No idempotency keys, audit logs, usage metering, plan gating, or billing primitives.

This plan upgrades the prototype into a production headless SaaS.

## 1) Product Definition

### Positioning
`Todoless` is an API-first task orchestration backend for developers and teams who need task primitives without adopting a heavy project-management suite.

Short pitch:
- "Headless task infrastructure for modern products."
- "Not Jira replacement. A programmable task layer."

### Target Customers
- Developer-led SaaS teams adding tasks to existing products.
- Startups building internal tools and operations dashboards.
- Agencies shipping client portals with task workflows.
- Product teams needing lightweight cross-functional execution.

### Differentiators vs Normal To-Do Apps
- API-first and UI-agnostic from day one.
- Multi-tenant + workspace-scoped API keys + webhook-first design.
- Strong sync model for mobile/offline clients.
- Predictable performance and low-complexity data model.
- Open core + hosted cloud model.

### Real-World Use Cases
- CRM adds follow-up tasks on lead stage changes.
- Ecommerce ops auto-creates fulfillment checklists.
- HR onboarding app provisions employee onboarding tasks.
- Engineering support portal tracks customer implementation tasks.
- Field teams use offline-first mobile task sync.

### Monetization Strategy
Open-core + hosted SaaS:
- Open-source core (`todoless-core`): single workspace, core CRUD, basic webhook support.
- Hosted SaaS (`todoless Cloud`): multi-workspace teams, usage metering, dashboard, billing, managed reliability.
- Enterprise add-ons: SSO/SAML, SCIM, advanced audit exports, custom retention, private networking.

## 2) Core Features (MVP vs Advanced)

### MVP (first sellable release)
- Workspaces, projects/lists, tasks, subtasks (1-level).
- Team membership + RBAC (Owner/Admin/Member/Viewer).
- API key auth with scopes and rotation.
- Task fields: title, description, status, priority, due date, assignee, labels, metadata JSON.
- Cursor pagination, filtering, full-text search.
- Soft delete + restore windows.
- Webhooks with signature + retries + delivery logs.
- Usage metering + Stripe subscriptions.
- Basic dashboard for keys, webhooks, usage, workspace settings.

### Post-MVP / Premium
- Recurrence rules (RFC 5545-lite), SLAs, reminders.
- Rules engine (trigger -> condition -> action).
- Advanced permissions (custom roles, field-level constraints).
- SSO/SAML/SCIM.
- Data residency options.
- AI features (task generation, summarization, auto-tagging, due-date extraction).

### Collaboration Model
- Workspace-level members.
- Project visibility: private, workspace, shared with specific members.
- Task assignment + watcher list.
- Comments with mentions and notification events.

### Automation & Rule Engine (post-MVP, but schema-ready in MVP)
- Triggers: `task.created`, `task.updated`, `task.completed`, `task.overdue`.
- Conditions: label/status/priority/project/assignee/metadata predicates.
- Actions: set fields, create subtask, assign user, call webhook endpoint, enqueue reminder.

### Event System + Multi-Workspace
- Every mutating operation writes a `ChangeLog` event in same DB transaction.
- Events feed sync API, webhook delivery, and audit logs.
- Strict workspace scoping in all queries and tokens.

## 3) Data Model & Schema (Prisma Style)

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum WorkspaceRole {
  OWNER
  ADMIN
  MEMBER
  VIEWER
}

enum ProjectVisibility {
  PRIVATE
  WORKSPACE
  SHARED
}

enum TaskStatus {
  TODO
  IN_PROGRESS
  DONE
  ARCHIVED
}

enum TaskPriority {
  P0
  P1
  P2
  P3
}

enum AuditAction {
  CREATE
  UPDATE
  DELETE
  RESTORE
  LOGIN
  INVITE
  BILLING_UPDATE
  API_KEY_CREATE
  API_KEY_REVOKE
}

enum ApiKeyType {
  WORKSPACE
  PERSONAL
  SERVICE
}

enum PlanTier {
  FREE
  PRO
  BUSINESS
}

model User {
  id                 String      @id @default(cuid())
  email              String      @unique
  displayName        String?
  passwordHash       String?
  createdAt          DateTime    @default(now())
  updatedAt          DateTime    @updatedAt
  memberships        Membership[]
  comments           Comment[]
  assignedTasks      Task[]      @relation("TaskAssignee")
  authoredAuditLogs  AuditLog[]  @relation("AuditActor")
  apiKeys            ApiKey[]
}

model Workspace {
  id                 String           @id @default(cuid())
  slug               String           @unique
  name               String
  planTier           PlanTier         @default(FREE)
  createdAt          DateTime         @default(now())
  updatedAt          DateTime         @updatedAt
  deletedAt          DateTime?
  memberships        Membership[]
  projects           Project[]
  tasks              Task[]
  labels             Label[]
  webhooks           WebhookEndpoint[]
  apiKeys            ApiKey[]
  auditLogs          AuditLog[]
  changes            ChangeLog[]
  entitlements       WorkspaceEntitlement[]

  @@index([planTier])
}

model Membership {
  id                 String         @id @default(cuid())
  workspaceId        String
  userId             String
  role               WorkspaceRole
  createdAt          DateTime       @default(now())

  workspace          Workspace      @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  user               User           @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([workspaceId, userId])
  @@index([userId])
}

model Project {
  id                 String            @id @default(cuid())
  workspaceId        String
  name               String
  description        String?
  visibility         ProjectVisibility @default(WORKSPACE)
  createdAt          DateTime          @default(now())
  updatedAt          DateTime          @updatedAt
  deletedAt          DateTime?

  workspace          Workspace         @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  tasks              Task[]

  @@index([workspaceId, createdAt])
}

model Task {
  id                 String        @id @default(cuid())
  workspaceId        String
  projectId          String?
  parentTaskId       String?
  assigneeUserId     String?
  title              String
  description        String?
  status             TaskStatus    @default(TODO)
  priority           TaskPriority  @default(P2)
  dueAt              DateTime?
  startsAt           DateTime?
  completedAt        DateTime?
  metadata           Json?
  version            Int           @default(1)
  createdAt          DateTime      @default(now())
  updatedAt          DateTime      @updatedAt
  deletedAt          DateTime?

  workspace          Workspace     @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  project            Project?      @relation(fields: [projectId], references: [id], onDelete: SetNull)
  assignee           User?         @relation("TaskAssignee", fields: [assigneeUserId], references: [id], onDelete: SetNull)
  parentTask         Task?         @relation("Subtasks", fields: [parentTaskId], references: [id], onDelete: SetNull)
  subtasks           Task[]        @relation("Subtasks")
  comments           Comment[]
  attachments        Attachment[]
  taskLabels         TaskLabel[]

  @@index([workspaceId, updatedAt])
  @@index([workspaceId, status, priority, dueAt])
  @@index([projectId, createdAt])
  @@index([parentTaskId])
}

model Label {
  id                 String       @id @default(cuid())
  workspaceId        String
  name               String
  color              String
  createdAt          DateTime     @default(now())

  workspace          Workspace    @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  taskLabels         TaskLabel[]

  @@unique([workspaceId, name])
}

model TaskLabel {
  taskId             String
  labelId            String

  task               Task         @relation(fields: [taskId], references: [id], onDelete: Cascade)
  label              Label        @relation(fields: [labelId], references: [id], onDelete: Cascade)

  @@id([taskId, labelId])
  @@index([labelId])
}

model Comment {
  id                 String       @id @default(cuid())
  workspaceId        String
  taskId             String
  authorUserId       String
  body               String
  createdAt          DateTime     @default(now())
  updatedAt          DateTime     @updatedAt
  deletedAt          DateTime?

  task               Task         @relation(fields: [taskId], references: [id], onDelete: Cascade)
  author             User         @relation(fields: [authorUserId], references: [id], onDelete: Restrict)
  workspace          Workspace    @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@index([workspaceId, createdAt])
}

model Attachment {
  id                 String       @id @default(cuid())
  workspaceId        String
  taskId             String
  uploadedByUserId   String
  storageKey         String
  fileName           String
  contentType        String
  byteSize           Int
  createdAt          DateTime     @default(now())
  deletedAt          DateTime?

  task               Task         @relation(fields: [taskId], references: [id], onDelete: Cascade)
  workspace          Workspace    @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@index([workspaceId, createdAt])
}

model ApiKey {
  id                 String       @id @default(cuid())
  workspaceId        String?
  userId             String?
  type               ApiKeyType
  name               String
  keyPrefix          String
  keyHash            String
  scopes             String[]
  lastUsedAt         DateTime?
  expiresAt          DateTime?
  revokedAt          DateTime?
  createdAt          DateTime     @default(now())

  workspace          Workspace?   @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  user               User?        @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([workspaceId, revokedAt])
  @@index([userId, revokedAt])
  @@unique([keyPrefix])
}

model WebhookEndpoint {
  id                 String            @id @default(cuid())
  workspaceId        String
  url                String
  description        String?
  events             String[]
  secretHash         String
  active             Boolean           @default(true)
  createdAt          DateTime          @default(now())
  updatedAt          DateTime          @updatedAt

  workspace          Workspace         @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  deliveries         WebhookDelivery[]

  @@index([workspaceId, active])
}

model WebhookDelivery {
  id                 String       @id @default(cuid())
  workspaceId        String
  endpointId         String
  eventId            String
  statusCode         Int?
  attempt            Int
  nextAttemptAt      DateTime?
  deliveredAt        DateTime?
  failedAt           DateTime?
  errorCode          String?
  errorMessage       String?
  requestBody        Json
  responseBody       String?
  createdAt          DateTime     @default(now())

  endpoint           WebhookEndpoint @relation(fields: [endpointId], references: [id], onDelete: Cascade)
  workspace          Workspace       @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@index([endpointId, createdAt])
  @@index([workspaceId, createdAt])
}

model ChangeLog {
  id                 String       @id @default(cuid())
  workspaceId        String
  sequence           BigInt       @default(autoincrement())
  entityType         String
  entityId           String
  operation          String
  payload            Json
  createdAt          DateTime     @default(now())

  workspace          Workspace    @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@unique([workspaceId, sequence])
  @@index([workspaceId, createdAt])
}

model IdempotencyKey {
  id                 String       @id @default(cuid())
  workspaceId        String
  key                String
  requestHash        String
  responseStatus     Int
  responseBody       Json
  createdAt          DateTime     @default(now())
  expiresAt          DateTime

  workspace          Workspace    @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@unique([workspaceId, key])
  @@index([expiresAt])
}

model AuditLog {
  id                 String       @id @default(cuid())
  workspaceId        String
  actorUserId        String?
  actorApiKeyId      String?
  action             AuditAction
  entityType         String
  entityId           String?
  before             Json?
  after              Json?
  ipAddress          String?
  userAgent          String?
  createdAt          DateTime     @default(now())

  workspace          Workspace    @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  actorUser          User?        @relation("AuditActor", fields: [actorUserId], references: [id], onDelete: SetNull)

  @@index([workspaceId, createdAt])
}

model WorkspaceEntitlement {
  id                 String       @id @default(cuid())
  workspaceId        String
  key                String
  value              String
  createdAt          DateTime     @default(now())
  updatedAt          DateTime     @updatedAt

  workspace          Workspace    @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@unique([workspaceId, key])
}
```

## 4) API Design (Headless-First)

### API Protocol Choice
- Primary: REST + OpenAPI 3.1.
- Optional later: GraphQL read endpoint for flexible dashboards.
- Reason: REST is simpler for SDK generation, caching, webhooks, and pricing by request.

### Core Endpoint Shape

Auth & keys:
- `POST /v1/auth/register`
- `POST /v1/auth/verify-email`
- `POST /v1/auth/login` (optional later if sessions are added)
- `POST /v1/auth/refresh` (optional later if sessions are added)
- `POST /v1/workspaces/{workspaceId}/api-keys`
- `POST /v1/api-keys/{apiKeyId}/rotate`
- `DELETE /v1/api-keys/{apiKeyId}`

Workspaces/projects:
- `GET /v1/workspaces`
- `POST /v1/workspaces`
- `GET /v1/workspaces/{workspaceId}`
- `PATCH /v1/workspaces/{workspaceId}`
- `GET /v1/workspaces/{workspaceId}/projects`
- `POST /v1/workspaces/{workspaceId}/projects`

Tasks:
- `GET /v1/workspaces/{workspaceId}/tasks`
- `POST /v1/workspaces/{workspaceId}/tasks`
- `GET /v1/tasks/{taskId}`
- `PATCH /v1/tasks/{taskId}`
- `DELETE /v1/tasks/{taskId}` (soft delete)
- `POST /v1/tasks/{taskId}/restore`
- `POST /v1/tasks/bulk` (bulk create/update/delete)

Comments/labels/attachments:
- `POST /v1/tasks/{taskId}/comments`
- `GET /v1/tasks/{taskId}/comments`
- `POST /v1/workspaces/{workspaceId}/labels`
- `POST /v1/tasks/{taskId}/attachments/presign`
- `POST /v1/tasks/{taskId}/attachments`

Webhooks/events:
- `GET /v1/workspaces/{workspaceId}/webhooks`
- `POST /v1/workspaces/{workspaceId}/webhooks`
- `GET /v1/webhooks/{webhookId}/deliveries`
- `POST /v1/webhooks/{webhookId}/test`

Sync:
- `GET /v1/workspaces/{workspaceId}/sync?cursor={cursor}&limit=1000`

### Filtering & Search
`GET /v1/workspaces/{workspaceId}/tasks` query params:
- `status`, `priority`, `assignee_id`, `project_id`
- `label` (repeatable)
- `due_from`, `due_to`, `updated_after`
- `q` (full-text on title/description)
- `include_deleted=true` (admin scope only)

### Pagination Strategy
- Cursor-based (`next_cursor`) with stable sort `updated_at DESC, id DESC`.
- No offset pagination in public API.

### Idempotency Strategy
- Required on non-idempotent writes: `Idempotency-Key` header.
- Server stores request hash + response in `IdempotencyKey`.
- Duplicate key with same hash returns cached response.
- Duplicate key with different hash returns `409 IDEMPOTENCY_KEY_REUSED`.

### Rate Limiting Model
- Token bucket per API key + per workspace + per IP (for auth endpoints).
- Example defaults:
  - Free: 120 req/min, 10k req/day
  - Pro: 1200 req/min, 500k req/day
  - Business: custom
- Response headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After`.

### Versioning Strategy
- URL versioning (`/v1`) + media type date version for previews.
- Breaking changes only in `/v2`.
- Additive fields allowed in minor releases.

### Example Request / Response

Request:
```http
POST /v1/workspaces/ws_123/tasks
Authorization: Bearer tdls_live_xxx
Idempotency-Key: 8b11ddf8-7d07-4f95-a7fc-14d3562f2f9d
Content-Type: application/json

{
  "title": "Review onboarding copy",
  "project_id": "prj_123",
  "priority": "P1",
  "assignee_user_id": "usr_456",
  "labels": ["content", "onboarding"],
  "due_at": "2026-02-08T18:00:00Z",
  "metadata": {
    "ticket_ref": "MKT-211"
  }
}
```

Response:
```json
{
  "success": true,
  "data": {
    "id": "tsk_9m4...",
    "workspace_id": "ws_123",
    "project_id": "prj_123",
    "title": "Review onboarding copy",
    "status": "TODO",
    "priority": "P1",
    "version": 1,
    "updated_at": "2026-02-05T19:31:13.124Z",
    "deleted_at": null
  },
  "meta": {
    "request_id": "req_4v7...",
    "idempotency_replayed": false
  }
}
```

Error:
```json
{
  "success": false,
  "error": {
    "code": "CONFLICT_VERSION_MISMATCH",
    "message": "Task was updated by another client",
    "details": {
      "task_id": "tsk_9m4...",
      "server_version": 4
    }
  }
}
```

## 5) Sync & Offline Strategy

### Delta Sync
- Maintain `ChangeLog` sequence per workspace.
- Client stores last `cursor`.
- `GET /sync` returns all changes after cursor:
  - `upserts`: latest entity snapshots.
  - `deletes`: tombstones (`id`, `deleted_at`, `entity_type`).

### Conflict Resolution
- Default policy: optimistic concurrency using `version`.
- Client sends `If-Match-Version` on PATCH.
- If mismatch:
  - return 409 with server entity snapshot,
  - client can merge and retry.
- Fallback policy for low-code clients: last-write-wins via `?conflict=lww`.

### Soft Deletes
- `deleted_at` set on delete.
- Hidden by default in list endpoints.
- Retention policy: purge after 30-90 days by plan.

### Timestamp Strategy
- All server timestamps in UTC ISO8601.
- `updated_at` and `version` updated atomically in transaction.

### Retry-Safe Writes
- Idempotency key required for `POST`/bulk mutation.
- Queue consumers and webhooks must be idempotent by `event_id`.

## 6) Event & Webhook System

### Event Types
- `workspace.member_added`
- `project.created|updated|deleted`
- `task.created|updated|completed|deleted|restored|overdue`
- `task.comment_created`
- `task.attachment_added`

### Delivery Architecture
1. API transaction writes business row + outbox (`ChangeLog`).
2. Queue producer enqueues event ID.
3. Webhook consumer resolves subscribed endpoints.
4. Delivery attempts logged in `WebhookDelivery`.

### Retry Policy
- Exponential backoff with jitter: 10s, 60s, 5m, 30m, 2h, 12h.
- Max attempts by tier (Free: 5, Pro+: 10).

### Dead Letter Handling
- On max failure, mark as dead and move to DLQ queue/table.
- Expose manual replay endpoint in dashboard.

### Signature Verification
- Header:
  - `X-Todoless-Signature: t=<unix>,v1=<hmac_sha256>`
  - `X-Todoless-Event-Id`
- Signed payload: `${timestamp}.${raw_body}`.
- Reject if timestamp older than 5 minutes (replay protection).

### Ordering Guarantees
- Exactly-once not guaranteed.
- At-least-once guaranteed.
- Ordered per `workspace_id + endpoint_id` using serialized dispatch key.
- Consumers must deduplicate by `event_id`.

## 7) SDK & Integration Layer

### SDK Recommendation
- First-class handwritten SDK: TypeScript.
- Generated SDKs from OpenAPI: Python, Go, Kotlin.
- CLI for ops/dev workflows: `todoless` (`create-task`, `sync`, `replay-webhook`).

### SDK Generation Approach
- OpenAPI as source of truth.
- Use codegen for base clients.
- Wrap generated clients with ergonomic helpers (pagination iterators, retries, idempotency helper).

### Example TypeScript SDK Usage
```ts
import { Todoless } from "@todoless/sdk";

const client = new Todoless({
  apiKey: process.env.TODOLESS_API_KEY!,
  workspaceId: "ws_123",
});

const task = await client.tasks.create({
  title: "Prepare customer handoff",
  priority: "P1",
  labels: ["handoff", "customer-success"],
});

for await (const t of client.tasks.list({ status: "TODO" })) {
  console.log(t.id, t.title);
}
```

### Embeddable Widget Option
- Provide optional web component `<todoless-task-panel />`.
- Uses scoped API key and restricted permissions.
- Useful for customers who want instant UI with limited custom code.

## 8) Infrastructure & Stack (Serverless/Edge-Friendly)

### Recommended Production Stack
- Runtime/API: Cloudflare Workers + Hono (TypeScript).
- Database: Postgres (Neon) via Cloudflare Hyperdrive.
- Queue/Eventing: Cloudflare Queues.
- Object Storage: Cloudflare R2 for attachments.
- Cache/limits: Cloudflare KV (rate limit counters + ephemeral cache).
- Auth:
  - API: workspace/service API keys (hashed + prefix lookup).
  - Dashboard: Better Auth or Auth.js + passkeys/OAuth.
- Billing: Stripe Billing + webhooks.
- Observability: Sentry + OpenTelemetry traces + Cloudflare analytics/logpush.

### Why this stack
- Worker-hostable and globally low-latency.
- Avoids DB connection storm through Hyperdrive.
- Queues gives robust async retries + DLQ.
- R2 keeps attachment cost predictable.
- OpenAPI-driven SDKs maximize developer adoption.

### Deployment Environments
- `dev`, `staging`, `prod` with isolated DB/queues/buckets.
- `wrangler` environment config + secret bindings.
- GitHub Actions CI with migration checks and contract tests.

## 9) Security & Multi-Tenant Design

### Tenant Isolation
- Every domain model row carries `workspace_id`.
- API middleware derives scope from API key/JWT membership.
- Query builders require `workspace_id` predicate.
- Deny-by-default authorization checks in use-case layer.

### Access Control
- RBAC matrix:
  - Owner: billing, roles, all resources.
  - Admin: all workspace operations except billing ownership transfer.
  - Member: CRUD on allowed projects/tasks.
  - Viewer: read-only.

### API Key Scopes
Examples:
- `tasks:read`, `tasks:write`, `projects:read`, `projects:write`, `webhooks:write`, `workspace:admin`.
- Keys can be workspace-scoped or personal.
- Key rotation with overlap window and audit logging.

### Data Partitioning
- MVP: shared Postgres with strict row scoping.
- Scale phase:
  - hash partition high-volume tables by `workspace_id`,
  - optional dedicated DB for enterprise tenants.

### Additional Security Controls
- Hash API keys with Argon2id.
- Encrypt sensitive columns at app layer where needed.
- TLS everywhere.
- Webhook signature + replay window checks.
- Audit log immutable append-only path.

## 10) Pricing & Packaging

### Free Tier
- 1 workspace
- 3 members
- 5k tasks/month mutated
- 10k API requests/month
- 1 webhook endpoint
- Community support

### Pro Tier ($39/workspace/month + overage)
- 10 workspaces
- 25 members/workspace
- 250k API requests/month
- 50 webhook endpoints/workspace
- Automation rules (basic)
- Priority email support

### Business Tier ($299+/month)
- Unlimited workspaces/members (fair-use)
- SSO/SAML + SCIM
- Advanced audit export
- Dedicated throughput and SLA
- Data retention controls
- Private support channel

### Feature Gating Strategy
- Entitlements loaded from `WorkspaceEntitlement` per request.
- Hard limits for resource counts.
- Soft limits for usage with alerts then overage billing.
- Keep core task CRUD and portability in open-source edition.

## 11) 30-Day Build Roadmap

### Week 1 (Days 1-7): Foundation
- Initialize monorepo: `apps/api`, `apps/dashboard`, `packages/sdk`, `packages/openapi`.
- Set up Cloudflare Worker + Hono + Postgres schema + migration tooling.
- Implement auth + workspace/membership + API key hashing.
- Add request context, correlation IDs, structured logging.

Milestone:
- Secure multi-tenant skeleton with health checks and CI.

### Week 2 (Days 8-14): Core Task Engine
- Implement projects/tasks/subtasks/comments/labels.
- Add filtering/search/cursor pagination.
- Implement soft deletes + audit logs + idempotency keys.
- Build OpenAPI docs + contract tests.

Milestone:
- Reliable headless task CRUD with SDK-ready API.

### Week 3 (Days 15-21): Sync + Events + Webhooks
- Implement `ChangeLog` outbox and `/sync` API.
- Add webhook endpoints, signed deliveries, retries, DLQ, replay endpoint.
- Add usage metering and rate limiting.

Milestone:
- Production-grade event + offline sync backbone.

### Week 4 (Days 22-30): SaaS Surface + Launch Prep
- Minimal developer dashboard: API keys, webhooks, usage, billing.
- Stripe subscription integration + entitlement gates.
- Publish TS SDK + quickstart examples.
- Launch docs, onboarding templates, and first public repo.

Milestone:
- Paid beta launch with first design partners.

### Risk Areas
- Multi-tenant authorization bugs.
- Webhook retry/idempotency correctness.
- Sync conflict edge cases on mobile offline clients.
- Search performance as task volume grows.

### Scaling Considerations
- Add read replicas/caching for list-heavy workloads.
- Partition large tables by tenant hash.
- Optional durable object per workspace for hot-tenant ordering.
- Background compaction for old changelog and webhook logs.

## 12) Skills / MCP / AI Recommendation

### Do you need skills or MCP to build core Todoless?
- Not required for core implementation.
- Helpful for productivity and deployment workflows.

Use now:
- `cloudflare-deploy` skill for infra/deploy specifics.

Use later if needed:
- `sentry` skill for production issue triage.
- `figma` skill only when you start dashboard UI from Figma.

MCP:
- Optional. Valuable when integrating external design/docs/data systems.
- Not a blocker for API-first launch.

### Practical AI Integration (v1.5, not day-1 blocker)
- `POST /v1/ai/parse-task`: convert text to structured task fields.
- `POST /v1/ai/summarize-project`: summarize overdue blockers.
- `task.ai_suggested_due_at` and `task.ai_tags` as optional metadata.
- Run AI jobs async through queues to keep write latency low.
- Keep all AI features behind explicit opt-in and usage quotas.

## 13) Immediate Next Build Step

Start with a clean production core while preserving your existing prototype as a reference:
1. Keep `files/server.js` as demo reference.
2. Scaffold `apps/api` Worker + Hono + Postgres schema from this plan.
3. Implement auth + workspace + membership + API keys first.
4. Add tasks + sync + webhook pipeline in that order.
