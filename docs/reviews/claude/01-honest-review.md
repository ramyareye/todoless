# Honest Review of Todoless (as of Feb 2026)

## Overall Verdict

You're in a strong position — stronger than most solo founders at this stage. You have a clear product thesis, a working production API foundation, solid strategy docs, and you've consulted multiple AI tools to stress-test the idea. That's smart. But I want to be direct about what's actually good, what's missing, and where I think effort is being wasted.

## What I'm genuinely impressed by

**1. The API foundation (`apps/api`) is real production code, not toy code.**
The `index.ts` is ~840 lines of clean, well-structured Hono + D1 with proper auth middleware, API key hashing (SHA-256 with pepper), scoped RBAC, audit logging, Zod validation, request IDs, and a consistent error envelope. This is not a tutorial project — this is the skeleton of a real multi-tenant SaaS API. Most founders at this stage have a Next.js app with a `/api/todos` route and plaintext passwords. You're miles ahead.

**2. The migration schema is correct and minimal.**
`0001_initial.sql` creates exactly the tables you need for Week 1 — users, workspaces, memberships, api_keys, audit_logs — with proper foreign keys, indices, and constraints. No premature optimization, no over-engineering. This is the right level of schema for day one.

**3. The strategy docs are unusually good.**
`todoless-outside-in-strategy.md` is the standout. The positioning pivot from "headless todo" to "workflow task infrastructure for SaaS products" is the single most important strategic decision in the project. The wedge ("Customer Operations Task Infrastructure") is specific, defensible, and monetizable. Most solo founders can't articulate this clearly.

**4. The roadmaps are realistic.**
Both the 12-week and 24-week roadmaps respect the 6-8 hours/week constraint. The "one outcome per week" rule and the "no new feature if previous week is incomplete" guardrail show operational maturity. The fallback rule (keep API correctness > keep security > defer polish) is correct.

**5. The WfP evaluation is the right call.**
Deciding NOT to use Workers for Platforms right now, while keeping the architecture WfP-ready, is exactly the kind of decision that separates shipping founders from architecture astronauts.

## What concerns me

**1. The `files/` prototype is dead weight.**
`files/server.js` (Express + SQLite + plaintext API keys) and the demo JSX were useful for proving the concept. But they're now sitting next to the real production code in `apps/api`, creating confusion about what's canonical. The prototype uses completely different patterns (plaintext keys, hard deletes, offset pagination, inline webhooks). Having both codebases in the same repo sends a mixed signal.

*Recommendation:* Archive `files/` to a `_archive/` directory or remove it entirely. Reference it in a CHANGELOG if you want to preserve the history. Don't let the prototype confuse future contributors (including future-you).

**2. You have too many planning documents and not enough shipping artifacts.**
You have:
- `todoless-plan.md` (857 lines of comprehensive blueprint)
- `todoless-outside-in-strategy.md` (287 lines of strategy)
- `docs/licensing-strategy.md`
- `docs/weekly-side-roadmap.md` (24 weeks)
- `docs/weekly-mvp-roadmap-12-weeks.md` (12 weeks)
- `docs/week-01-checklist.md`
- `docs/workers-for-platforms-evaluation.md`
- `chatgpt.txt`, `claude.txt`, `gemini.txt`

That's ~2,500+ lines of planning for a project with ~840 lines of actual code. The ratio is off. Planning is valuable, but at some point you need to stop planning and start shipping Week 2 (projects + tasks). The planning docs are excellent, but they can become a procrastination trap if you keep refining them instead of building.

**3. The API has no task endpoints yet.**
This is the core product. You have auth, workspaces, memberships, API keys — but zero task-related functionality. No `projects` table, no `tasks` table, no CRUD for the thing your customers actually want. Week 1 is done. Week 2 needs to start immediately.

**4. The single-file API will become painful soon.**
`index.ts` at 840 lines is manageable today, but once you add projects, tasks, labels, comments, webhooks, sync — it'll be 3,000+ lines. The code is well-organized with helper functions, but there's no route separation, no service layer, no repository pattern. You should split before it becomes a refactoring project.

**5. The API key hashing uses SHA-256, not Argon2id.**
The plan doc explicitly says "Hash API keys with Argon2id" but the implementation uses `crypto.subtle.digest('SHA-256')`. SHA-256 with a pepper is acceptable for API keys (they're high-entropy random strings, not passwords), but if you're going to claim Argon2id in your docs, either implement it or update the docs. Consistency matters for trust.

**6. No tests whatsoever.**
Zero test files. No unit tests, no integration tests, no contract tests. The Week 1 checklist says "verify endpoints with manual API checks" — but there's no automated way to catch regressions. Before Week 2 starts, you need at least endpoint smoke tests.

**7. The three AI brainstorm files are noise.**
`chatgpt.txt`, `claude.txt`, and `gemini.txt` are raw chat transcripts. They were useful as inputs, but they don't belong in the repo root. They add noise and make the project look unfinished. Move them to `_research/` or remove them.

## What's missing that should exist

1. **A `LICENSE` file** — the licensing strategy doc recommends Apache-2.0 but there's no actual LICENSE file
2. **A `.env.example` or equivalent** at root level (the API has `.dev.vars.example` but nothing top-level)
3. **Any form of CI/CD** — no GitHub Actions, no lint config, no pre-commit hooks
4. **An OpenAPI spec** — the plan says "OpenAPI as source of truth" but none exists yet
5. **Error handling tests** — the auth middleware has good error paths but they're unverified
6. **Rate limiting** — mentioned in every planning doc but not implemented

## The bottom line

You have a genuinely good foundation and an unusually clear strategy. The risk isn't that the idea is bad or the code is bad — the risk is that you keep planning instead of shipping. The next 200 lines of code you write (projects + tasks CRUD) are worth more than the next 2,000 lines of planning docs.
