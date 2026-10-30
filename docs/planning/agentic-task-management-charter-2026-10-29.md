# Todoless: coordination for people and agent harnesses

Product direction, 29 October 2026. This charter guides later checkpoints; it does
not authorize code, access, task-import, deployment, Git or payment changes.

## Purpose

Give small teams of people and agents a shared, durable execution queue. A person
sets the intended outcome and boundaries. An executor does bounded work and brings
back evidence. The team can see what happened, what is blocked, who decides next
and how to resume safely.

Todoless owns current assignments, status, dependencies, blockers and review. Repos
retain technical contracts, setup and implementation evidence. People and agents
use the same small API/MCP contract through clients they choose.

## Role in a harness

Todoless can be the durable coordination layer used by a harness. The harness
manages its model, tools, context and execution environment. Todoless records the
assignment, responsible person, current attempt, dependencies, permitted scope,
evidence and decisions across sessions and tools. Start with existing Codex chats
as executors; an automatic dispatcher is a later, optional client of the same API.

Keep three responsibilities clear:

- **People:** decide intended outcomes, priorities and exceptional actions.
- **Harnesses:** execute bounded work, test it and report progress or uncertainty.
- **Todoless:** retain shared coordination state and enforce the permissions its
  API can actually enforce.

This is a product boundary, not a claim that the current backend already enforces
all delegated authority. A task's approval cannot block a shell command or a
deployment made outside Todoless. Execution tools must enforce those boundaries
too. Repositories and Git retain source history; task history links to that
evidence rather than replacing it.

The human view should answer: what is moving, what is blocked, what needs my
decision, and what evidence supports completion? Administrative effort should fall
as agents report structured updates. Avoid requiring people to maintain a second
copy of an agent's logs or inventing a manager agent before the contract works.

## Principles

- **People own direction and authority.** Humans choose priorities, accept material
  scope changes and decide releases, security/access changes and spending. Existing
  exact Git approval gates remain binding. Permission to implement is a bounded
  grant; it is not permission to commit, publish or grant access.
- **Agents are executors with attribution.** Keep human responsibility separate
  from the agent/run doing the work. Authenticate the actual actor; an agent name
  in a payload is a label, not proof of identity or permission.
- **Assignments are executable handoffs.** Record outcome, bounded scope, owner,
  repository, dependencies, allowed actions, acceptance evidence and reviewer.
  Agents can propose and clarify work before it becomes Ready.
- **Review concerns meaningful decisions.** Let authorized routine work continue.
  Pause when a decision exceeds its grant. Present the concrete change, evidence,
  consequences and next action; preserve approval scope across interruption/retry.
- **Progress has evidence.** Keep revision/build/environment and test/result links.
  Source complete, reviewed, deployed and verified are separate facts. A status
  label or an executor's assertion does not establish all of them.
- **Work survives interruption.** A blocker records reason, resolver and next
  action. A paused attempt records what changed and where to resume. Lease expiry
  surfaces uncertainty; it must not silently duplicate execution or side effects.
- **Minimal core, open contract.** External tools perform execution. Keep the
  backend small, open source and headless; no model subscription, hosted agent
  runtime, workflow builder or new platform is required by this direction.

## The working loop

`Intent -> Ready -> Claim -> Work -> Evidence -> Review -> Verify`

Keep the existing task stages: Backlog, Ready, Active, Blocked, Review, Verify,
Done and Archived. Claim/run/approval records describe execution and authority;
they should not become a new task status for every tool event.

Example: Reza sets a Veloura referral outcome. The backend executor works on its
existing backend card and attaches contract/test evidence. The app card keeps the
real dependency visible. Once the contract is ready, its executor continues in the
app repository, submits evidence and requests review. Reza accepts or returns the
work with a reason; the relevant environment is verified before completion. A
production rollout still needs its own existing authorization.

## Keep what already works

- Stable task IDs, project queues, human assignees and frontend/backend separation.
- Ready/Blocked/Review/Verify, dependencies, progress/evidence and audit history.
- One active priority per responsible person and up to two Ready alternatives.
  Agent attempts should not manufacture extra human priorities. Additional agent
  concurrency would need explicit limits and a deliberate later decision.
- Shared personal availability, including zero-day stretches, stays separate from
  actual human hours and owner approval. Agent activity never invents billable
  human time; rates/currency/caps remain unset and payments manual.
- HipHop.dev pilots Grow, Veloura and WF. Company work stays in Linear. HopKit's
  life planning/shopping/routines and future generator/platform work remain outside
  this execution queue's scope.

## The next bounded product checkpoint

Update 30 October: first compare the existing Synth Cloudflare OS trial and
Paperclip with our needs. The [product and market review](../research/todoless-product-market-direction-2026-10-30.md)
adds this evidence gate before new orchestration work. Keep the team queue usable;
HopKit remains an optional interface. The following delegation design is a
candidate for a demonstrated gap, not an automatic build list:

1. An additive attempt record with authenticated actor/key, executor label,
   repository/base revision, progress, outcome, evidence and resume note.
2. Atomic versioned claim and release, with retry receipts. Competing executors
   cannot both own one attempt. Uncertain/expired work requires reconciliation.
3. Narrow project/action/expiry grants and a stored human decision for sensitive
   actions. An approval belongs to the proposed action/version and an authorized
   reviewer; changing its substance invalidates that approval.
4. Replay-safe creation/intake before agents create work autonomously. Reuse the
   existing queue and search for an existing card rather than duplicating backlogs.
5. Pilot one existing Grow or Veloura handoff through its current Codex chats,
   without launching an orchestration service or importing another backlog.

Current security gap: agents commonly use a person's API key. The API then sees
that user's authority and cannot reliably distinguish an agent action from a
human decision. Task-review rules also permit some owner/admin self-review, while
weekly hours forbid self-approval. Keep those facts explicit: instructions and
status fields alone cannot enforce the future delegated-approval boundary. Preserve
existing keys during an additive transition; do not give unattended agents broader
authority before delegation and review are enforced and tested.

Success means fewer coordination messages, fewer duplicate implementations, clear
blocked decisions, useful evidence and reliable resumption. Agent/task counts and
volume of generated code are not success measures.

## Checkpoints and source history

Finish bounded source changes with focused validation and a reviewed Git
checkpoint. Record the revision or candidate hash with task evidence; mark local,
committed, pushed, deployed and verified states accurately. Uncommitted release
artifacts and handoff notes help recovery but do not replace committed source.
Push after the agreed checkpoint when its CI/deployment effects are known and
the existing push gate is satisfied. Never infer Git authorization from this
charter or manufacture historical commits for work that was not committed then.

## Position

Agent delegation is already part of established tools, including
[Linear's agent platform](https://linear.app/docs/agents-in-linear). Todoless's bet
is a small, open execution contract that teams can use with their own clients and
agents. Its practical direction is **humans set direction; agents do bounded work;
every handoff stays inspectable and interruptible**.

For implementation reference, [OpenAI's approval/resumption guidance](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)
describes pausing before a protected tool call and resuming from stored state. This
is a useful pattern, not a requirement to adopt its SDK or trust client-supplied
approval state.

[Anthropic's long-running harness research](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
also emphasizes incremental work, persistent progress, Git checkpoints and real
verification. Todoless can supply shared assignment and handoff state around
that loop while each executor retains its own runtime.
