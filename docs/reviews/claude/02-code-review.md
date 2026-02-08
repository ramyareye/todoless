# Code Review: apps/api/src/index.ts

## Summary

The API foundation is solid production-quality code. This isn't a tutorial rewrite — it's well-architected multi-tenant SaaS scaffolding. Below is a detailed review of what works well and what needs attention.

## Strengths

### Auth & Security
- API key format (`tdls_live_<prefix>_<secret>`) is well-designed — the prefix enables fast DB lookup without exposing the secret in queries
- Keys are hashed with SHA-256 + pepper before storage — never stored plaintext
- Key prefix uniqueness constraint prevents collisions
- Expired and revoked keys are properly rejected
- `last_used_at` is updated asynchronously via `waitUntil` — smart, doesn't block the response

### RBAC
- `ROLE_RANK` numeric comparison is clean and extensible
- `requireMembership` correctly checks both workspace existence and role level
- Scope checking supports wildcards (`*`) and namespace wildcards (`workspace:*`)
- Every protected endpoint checks both scope AND role — defense in depth

### API Design
- Consistent response envelope (`{ success, data, meta: { request_id } }`)
- Validation errors return structured details (Zod's `flatten()`)
- Request IDs generated per-request and returned in headers
- Proper HTTP status codes throughout

### Database
- Batched inserts for registration (user + workspace + membership + API key in one `DB.batch()`)
- Workspace slug generation with random suffix to avoid collisions
- Audit logging on all sensitive operations

## Issues to Address

### Critical

**1. No CSRF / origin validation on register endpoint**
The register endpoint is completely open. Anyone can create unlimited users and workspaces. Before going to production, you need rate limiting on this endpoint at minimum.

**2. Workspace-scoped API key doesn't enforce workspace boundary**
When an API key has a `workspace_id`, the `authMiddleware` stores it in the principal but doesn't enforce it. The user can call `GET /v1/workspaces` and see ALL their workspaces, not just the one the key is scoped to. The key's `workspaceId` should be checked against the requested resource.

**3. Member upsert allows role escalation**
The `POST /v1/workspaces/:workspaceId/members` endpoint uses `ON CONFLICT ... DO UPDATE SET role`. An ADMIN could use this to change an existing member's role — including upgrading someone to ADMIN or changing an OWNER's role. The upsert should validate that:
- You can't change an OWNER's role
- You can't assign a role higher than your own

### Important

**4. Missing `Content-Type` validation**
The `jsonBody` helper silently returns `{}` on parse failure. This means a request with `Content-Type: text/plain` will pass validation for any schema with all-optional fields. Consider returning a 415 or 400 instead.

**5. Slug collision not fully handled**
`makeWorkspaceSlug` adds a 3-byte random suffix, giving 16.7M possibilities per slug base. That's fine early on, but the error handling on slug collision (`UNIQUE constraint failed`) returns a 409 — the user then has to manually retry. Consider auto-retrying with a different suffix.

**6. Audit log writes can fail silently**
`writeAudit` is awaited but failures don't propagate to the response. If the audit insert fails (e.g., FK violation), the business operation succeeds but the audit trail has a gap. Consider wrapping audit + business logic in the same batch where possible.

### Minor

**7. `ok()` and `error()` use `any` for the context type**
The helper functions type `c` as `any`. Since you're using Hono with proper generics (`AppEnv`), these should be typed as `Context<AppEnv>`.

**8. No pagination on workspace list or member list**
Both `GET /v1/workspaces` and `GET /v1/workspaces/:id/members` return all results unbounded. This is fine for small datasets but will become a problem.

**9. Key revocation allows self-revocation**
A user can revoke the API key they're currently using to make the request. This is technically correct but could be confusing. Consider warning or preventing this.

**10. Register creates a default "personal workspace" name from email**
`defaultWorkspaceName("reza@acme.com")` returns `"reza workspace"`. This is fine functionally but not great UX. Consider `"Reza's Workspace"` with proper capitalization.

## Architecture Recommendations for Week 2+

As you add projects, tasks, and more endpoints, the single-file structure will become unmanageable. Here's a suggested split:

```
src/
  index.ts              → app setup, middleware registration, export
  middleware/
    request-id.ts       → request ID middleware
    auth.ts             → auth middleware + helpers
  routes/
    health.ts           → health check
    auth.ts             → register (and later login/refresh)
    workspaces.ts       → workspace CRUD
    members.ts          → membership management
    api-keys.ts         → key creation/revocation
    projects.ts         → (Week 2)
    tasks.ts            → (Week 2)
  services/
    api-keys.ts         → issueApiKey, hashApiKey, extractKeyPrefix
    audit.ts            → writeAudit
  lib/
    ids.ts              → newId, randomHex
    response.ts         → ok, error, validationError
    types.ts            → shared types
```

This keeps each file under 200 lines and makes it easy to find things.
