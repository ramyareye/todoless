# Workers for Platforms Evaluation for Todoless

## Question
Should Todoless build on Cloudflare Workers for Platforms (WfP) now?

## Short answer
**Not for Week-1.**
Build on standard Workers first, then adopt WfP only when we need customer-executed code isolation at scale.

## What WfP is best for
WfP is built for platforms that let *their customers deploy Worker code* onto platform-owned domains/routes.

Cloudflare sources:
- WfP docs landing: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/
- How it works (dispatch namespace / user workers): https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/get-started/configuration/
- Example implementation repo: https://github.com/cloudflare/workers-for-platforms-example

Signals from docs/example:
- A "dispatcher" pattern routes requests to customer workers.
- Cloudflare recommends putting customer workers in a single namespace (manage by script name).
- The example separates concerns with platform-facing and end-user-facing worker setup.

## Todoless fit analysis
Current Todoless scope:
- API-first multi-tenant task backend
- Webhooks, RBAC, sync, automations

This does **not** require customer-hosted worker scripts yet.

## When WfP becomes valuable for Todoless
Adopt when we add “bring your own code” features, for example:
- Customer-defined automation code blocks
- Per-tenant custom transformation or policy workers
- Marketplace of installable extension workers

## Cost/complexity tradeoff
Benefits if adopted too early:
- Future-proof extension model

Costs if adopted too early:
- Extra platform complexity (dispatch namespaces, customer worker lifecycle, per-tenant observability)
- More moving parts before core product-market fit is proven

## Recommendation
Phase approach:
1. **Now**: standard Worker API + D1/Postgres + Queues.
2. **Later**: introduce WfP only for an extension runtime product tier.
3. Keep extension API contracts WfP-ready from day one (event schema, auth context, deterministic execution envelope).

## Technical guardrails to stay WfP-ready
- Keep automation execution behind an internal interface (e.g. `AutomationRuntime`).
- Emit strict event envelopes with versioned schema.
- Keep per-tenant isolation identifiers explicit in runtime context.
- Treat extension runtime as asynchronous and idempotent by design.
