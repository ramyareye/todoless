# Todoless Weekly Side-Job Roadmap

This roadmap is designed for a single founder/operator working part-time.

## Assumptions
- Time budget: 6 to 8 hours per week.
- Team: 1 person.
- Rule: ship one small thing weekly, not many partial things.
- Cadence: 3 focused sessions per week.
- Scope discipline: if a task exceeds the week, cut it and ship a thinner version.

## Weekly Operating Rhythm
- Monday (30 min): plan one weekly outcome, define "done", pick 1 fallback task.
- Midweek (2 sessions): build only the weekly outcome.
- Weekend (1 session): test, release notes, publish demo or changelog update.
- Sunday (15 min): log metrics and decide next week based on user feedback.

## 24-Week Roadmap (Light and Sustainable)

| Week | Focus | Scope (6-8h) | Ship This Week |
|---|---|---|---|
| 1 | Foundation hardening | Finalize Worker scaffold setup | Stable local dev flow and env setup docs |
| 2 | Core data v1 | Add `projects` + `tasks` tables and migrations | DB schema for projects/tasks |
| 3 | Task CRUD | Implement create/list/get/update for tasks | Usable task API endpoints |
| 4 | Quality buffer | Basic tests, bug fixes, request validation polish | First internal stable milestone |
| 5 | Query UX | Filtering, sorting, cursor pagination | Reliable `GET /tasks` query API |
| 6 | Safety model | Soft deletes + restore + audit events | Recoverable delete behavior |
| 7 | Multi-tenant rigor | Authorization pass on all endpoints | Workspace isolation checklist complete |
| 8 | Research + calls | 5 design-partner discovery calls | Problem notes + narrowed ICP |
| 9 | Webhooks v1 | Event outbox table + event payload contract | `task.created/updated/deleted` events |
| 10 | Delivery reliability | Queue delivery + retry/backoff + logs | Durable webhook delivery path |
| 11 | Security pass | API key rotation, revoke flows, scope matrix docs | Secure key lifecycle v1 |
| 12 | Buffer + docs | Fix issues from webhook/security work | Internal beta-ready API |
| 13 | DX foundation | OpenAPI spec + typed error model | Downloadable API contract |
| 14 | SDK alpha | TypeScript SDK with auth + task methods | `@todoless/sdk` alpha |
| 15 | Quickstart | Minimal sample app (web or RN) using SDK | "hello todoless" reference app |
| 16 | Docs sprint | Improve onboarding docs and copy | 15-minute time-to-first-task path |
| 17 | Billing prep | Stripe customer/workspace linkage model | Billing schema + webhook receiver stub |
| 18 | Metering | API usage counters and monthly usage records | Usage data visible per workspace |
| 19 | Entitlements | Enforce free/pro limits in middleware | Feature gating in API |
| 20 | Private beta start | Onboard 2-3 design partners | First real usage in production-like env |
| 21 | Sync differentiator | Change log feed + `/sync` cursor endpoint | Mobile/offline sync base |
| 22 | Conflict handling | Version checks + conflict responses | Predictable write conflict behavior |
| 23 | Automation v0 | Simple rule: trigger + one action | First programmable workflow |
| 24 | Launch prep | Pricing page, OSS README polish, launch checklist | Public beta launch candidate |

## Post-Launch Weekly Plan (Weeks 25-36)

| Week | Focus | Scope (6-8h) | Ship This Week |
|---|---|---|---|
| 25 | Stabilize | Fix top 10 beta issues | Beta reliability improvement |
| 26 | Onboarding funnel | API key wizard + better defaults | Faster activation |
| 27 | Integrations | Slack or Zapier starter integration | One visible ecosystem connector |
| 28 | Content loop | Publish deep technical post + example repo update | Inbound developer trust asset |
| 29 | Admin UX | Minimal usage + webhooks dashboard polish | Better paid conversion UX |
| 30 | Security/compliance | Audit export endpoint + retention settings | Early enterprise credibility |
| 31 | Team features | Invite flow polish + role management UX | Stronger B2B team adoption |
| 32 | Pricing iteration | Tune limits based on usage data | Better free-to-paid motion |
| 33 | SDK expansion | Python SDK beta | Non-JS developer reach |
| 34 | Reliability SLO | Track webhook success rate and p95 API latency | Public reliability metrics |
| 35 | WfP technical spike | Evaluate extension-runtime prototype with WfP | Go/no-go decision memo |
| 36 | Planning reset | Re-prioritize roadmap from real usage | Next 12-week plan with evidence |

## Side-Job Scope Guardrails
- Keep one "big thing" per week only.
- Every 4th week is buffer/fix/docs, not new feature work.
- No new feature starts without at least one user signal.
- Avoid UI-heavy work until API activation is healthy.
- Track only 3 KPI metrics weekly: `activated_workspaces`, `weekly_active_keys`, `free_to_paid_conversions`.

## Monetization Milestones
- Milestone A (Weeks 1-12): technically solid API, not monetized yet.
- Milestone B (Weeks 13-20): billing and entitlements live, first paid pilots.
- Milestone C (Weeks 21-24): launch candidate with sync + automation wedge.
- Milestone D (Weeks 25-36): improve retention and conversion based on usage data.

## Practical Definition of Done Each Week
- Feature merged.
- Minimal tests added or updated.
- Docs updated.
- Changelog entry added.
- One demo request/response saved for future onboarding content.
