# AGENTS.md

## Scope
- This repository uses a single root `AGENTS.md` as the agent instruction file.
- Do not add `CLAUDE.md`, `.cursorrules`, `.cursor/rules`, `GEMINI.md`, `.windsurfrules`, or `.github/copilot-instructions.md` unless the user explicitly asks for them.

## Repository Purpose
- `Todoless` is a headless task infrastructure project.
- Main code lives in:
  - `apps/api`: Cloudflare Worker API built with Hono, TypeScript, and D1.
  - `apps/mcp-server`: MCP adapter exposing Todoless tools.
- Supporting material lives in:
  - `docs`: planning, reviews, research, and archived prototype material.
  - `TASKS.md`: current execution checklist.

## Source Of Truth
- Treat production code in `apps/api` and `apps/mcp-server` as the source of truth.
- Treat `README.md`, `apps/api/README.md`, and `TASKS.md` as the current operational docs.
- Treat `docs/archive` as historical reference only unless the user asks to revive something from it.
- Treat `docs/reviews/claude` as advisory review material, not implementation truth.

## Working Rules
- Keep changes focused and minimal.
- Preserve the existing architecture: worker-first API, explicit route/service separation, scoped MCP adapter.
- Do not introduce new frameworks, large abstractions, or repo-wide refactors unless the user asks.
- Prefer small composable utilities over clever indirection.
- Maintain multi-tenant and RBAC assumptions when touching auth, workspaces, members, projects, tasks, or API keys.
- Keep API behavior consistent with documented contracts, especially pagination, optimistic concurrency, scopes, and error handling.

## Validation
- For API changes, use:
  - `cd apps/api && bun run typecheck`
  - `cd apps/api && bun run test:api`
  - `cd apps/api && bun run smoke`
- For MCP changes, use:
  - `cd apps/mcp-server && bun run validate`
- If a command cannot be run, state that clearly in the final response.

## Implementation Notes
- Pagination uses cursor-based responses with `pagination.next_cursor` and `pagination.has_more`.
- Task updates use optimistic concurrency via version checks.
- JSON endpoints are expected to enforce `content-type: application/json`.
- Security-sensitive areas include API key creation, key hashing, workspace authorization, and rate limiting.

## Editing Guidance
- Update docs when behavior or commands change materially.
- Avoid editing unrelated planning or review files unless they are directly relevant to the task.
- Prefer ASCII-only edits unless a file already requires otherwise.
- Follow existing naming and file organization patterns.

## Delivery
- In final responses, summarize what changed, list validation performed, and note any remaining risks or follow-ups.
