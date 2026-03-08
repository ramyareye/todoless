---
name: todoless-integration
description: Use when a task involves integrating another project, agent, or client with Todoless via its API or MCP server. Covers when to use API vs MCP, how to obtain and use per-user API keys, how to configure local STDIO MCP or hosted MCP, and the core workspace/project/task/member flows.
---

# Todoless Integration

Use this skill when the user wants to connect another project, app, or AI agent to Todoless.

## What Todoless exposes

- API base URL: `https://todoless.dev`
- Hosted MCP URL: `https://mcp.todoless.dev/mcp`
- Local MCP server entrypoint: `apps/mcp-server/src/server.mjs`

Todoless is user-based:

- users belong to one or more workspaces
- projects and tasks live inside a workspace
- personal API keys are tied to a user, not to a single workspace
- API and MCP visibility come from workspace membership

## Choose API vs MCP

Use the API when:

- the caller needs auth bootstrap
- you need direct HTTP control or backend integration
- you need exact endpoint/response handling
- you are building product code, automation, or tests

Use MCP when:

- an AI agent needs task/project/member tools
- the client already supports MCP well
- the workflow is tool-driven rather than raw HTTP

Do not use MCP for registration or invite claim bootstrap. Use the API for that first.

## Auth model

Canonical flow:

1. Register or claim invite through the API.
2. Receive a personal API key.
3. Use that key for API calls.
4. Use that same key for MCP.

Important:

- `POST /v1/auth/register` returns the personal key once
- `POST /v1/auth/claim-invite` returns the personal key once
- hosted MCP is per-user by bearer token
- local STDIO MCP uses `TODOLESS_API_KEY`

## What to read next

Read [references/setup-and-flows.md](./references/setup-and-flows.md) when you need:

- cURL examples
- MCP config examples
- invite flow
- `/v1/me` response shape
- common integration patterns

## Operating rules

- Default to `https://todoless.dev` unless the user explicitly points to another environment.
- Assume personal user keys, not shared service keys.
- If building a SaaS or hosted AI integration, prefer hosted MCP with user bearer tokens.
- If building local tooling for a developer, local STDIO MCP is fine.
- Keep workspace IDs explicit in API calls and MCP tool arguments.
- For task mutations, preserve optimistic concurrency when using the API directly.

## Quick memory

- `GET /v1/me` returns `data.user`, `data.scopes`, `data.api_key_id`
- members are added to workspaces, not directly to projects
- tasks can be reassigned to any current workspace member
- invite links use `https://todoless.dev/accept-invite?token=...`
