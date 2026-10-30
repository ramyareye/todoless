# Todoless product and market direction

30 October 2026. Prepared for Reza and the HipHop.dev team.

## Recommended direction

Keep Todoless as the team's working task backend while testing whether a small,
open coordination API deserves to become a wider product. Evaluate the existing
Cloudflare OS trial and Paperclip before building orchestration. A reliable team
tool can be a successful outcome even if it never becomes a commercial product.

The product hypothesis is: **small teams using several coding agents need a
shared work queue that keeps ownership, dependencies, decisions and evidence
intact across repositories and sessions.** We have internal reasons to test this;
we do not yet have external demand or willingness-to-pay evidence.

The earlier agent charter describes a possible architecture. Its proposed claims,
attempts and grants now need an alternatives trial before becoming implementation
priorities. This research does not authorize installations, integrations, access
changes, deployments, invitations, messages, task imports, commits or pushes.

## Two purposes with different success measures

| Purpose | Who benefits first | Evidence of success |
| --- | --- | --- |
| Team delivery | Reza, the developer and a nontechnical product collaborator | Work resumes without reconstructing Telegram/chat history; blockers and review decisions are clear; releases keep moving. |
| Open source adoption | Other small product teams using several tools and agents | Teams install or connect it for their own work, continue using it, and can explain why an existing alternative was insufficient. |
| Possible business | A subset of those external teams | Someone makes a concrete paid commitment for an agreed service or support outcome. Signups, stars and model endorsements are insufficient. |

For the team, preserve Grow and Veloura's separate app/backend queues, existing
IDs, assignees, history and approval boundaries. WF remains a priority product;
other independent projects can share the portfolio. Celebratix stays in Linear.
One active priority plus up to two Ready alternatives remains the desired habit.
The existing API enforces active work per workspace; it does not provide a global
agent lease across every workspace and runtime.

Optional shared daily availability, including zero days, stays separate from
actual human hours and weekly approval. The developer's approximately ten hours
per week is shared availability, not a billing cap. Rate, currency and cap remain
unset; payments stay manual. [Current delivery contract](../planning/delivery-queue-checkpoint-2026-10-22.md),
[time contract](../planning/team-hours-checkpoint-2026-10-21.md).

## What already exists

These are documented capabilities, not results of a hands-on comparison. The last
column states what our trial must establish rather than asserting a competitor
cannot meet the need.

| Option | Documented capability | What to test for our needs |
| --- | --- | --- |
| [Cloudflare OS](https://github.com/cloudflare/cloudflare-os) | Browser agent workspace, app building and service access controls; Apache-2.0; README warns of early-access rough edges. | Can the existing trial handle everyday coordination with an existing backend, within acceptable access and cost boundaries? |
| [Paperclip](https://github.com/paperclipai/paperclip) | Tasks for people/agents, atomic checkout, saved execution context, review stages, budgets and runtime adapters. | Could adopting it remove the need to build Todoless orchestration? Test setup burden, the human workflow and project isolation. |
| [Linear agents](https://linear.app/docs/agents-in-linear) | Third-party agent delegation, team-scoped installation, guidance and activity visibility. Agents are not billable seats; their providers may charge separately. | Is Linear plus existing coding tools already the best complete answer for a small team? |
| [GitHub Issues dependencies](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies) and [Copilot](https://docs.github.com/en/copilot/concepts/copilot-surfaces/copilot-on-github) | Issue blockers and a repository-centered route from conversation to code changes and review. | Does keeping work beside its repositories eliminate enough coordination friction without another backend? |
| [Plane](https://github.com/makeplane/plane) | Open-source project management with work items, cycles and roadmaps; cloud and self-hosted options. Community repository is AGPL-3.0. | Would an established open-source tracker with integrations be easier for our human collaborators? |
| [Beads](https://github.com/gastownhall/beads) | Dependency-aware agent work graph, Ready/claim flow and persistent context, using Dolt. README also describes an experimental HTTP backend. | Can it supply the agent coordination we need? Test cross-project visibility and the nontechnical colleague's access workflow. |
| Existing task queue and repository notes | Our current integration and contracts already exist. | Measure the actual remaining pain before adding another service, UI or synchronization layer. |

Paperclip is a particularly direct challenge to the broad orchestration proposal:
its published design already includes several of our proposed next primitives.
Linear also already supports people working with agents. Neither an AI label nor
open source establishes an underserved market.

For price context, Linear currently lists Free with unlimited members, two teams
and 250 issues; Basic at $10/user/month and Business at $16/user/month, billed
yearly. Its table includes API/MCP access and the agent platform across plans;
some execution features require AI credits. Compare the required tier and agent
costs, not just a seat-price headline. [Linear pricing](https://linear.app/pricing).

## Where Cloudflare OS fits

The user confirmed [os.cloudflare.app](https://os.cloudflare.app/) and supplied a
screenshot of their trial at `synth.hiphop.dev`. The screenshot shows the home UI
and an existing gadget workspace. Access policy, connected resources, effective
billing limits and production suitability still need their own validation.

Cloudflare's launch describes a combination of organizational context, agents,
security and modifiable apps. Its 1 October update added working with existing
GitHub repositories and announced a managed-deployment waitlist. Cloudflare OS
therefore overlaps with parts of both the proposed harness and a human client.
[Launch](https://blog.cloudflare.com/cloudflare-os/),
[October update](https://blog.cloudflare.com/managed-cloudflare-os/).

Use Synth as a candidate workspace/runtime. Keep Todoless as the authoritative
task queue during evaluation. HopKit Delivery is an optional client; its existing
life planning, shopping and routines remain separate. No new client is required
just to validate task coordination.

```text
People choose outcomes, boundaries and decisions
                 |
      Clients selected for the job
  Codex chats | Synth trial | HopKit if useful
                 |
      Todoless API and MCP task state
 assignments | dependencies | blockers | review | evidence
                 |
   Repositories retain code, contracts and test evidence
```

This is a candidate arrangement. Avoid permanent duplicate task databases or
bidirectional sync during the trial. Paperclip should also be tested as a
replacement option, rather than automatically connecting every product together.

### Integration and approval boundaries

Cloudflare OS Gatekeepers use Cap'n Web interfaces and resource introductions;
they can simulate proposed actions before a person approves them. A compatible
Todoless connection needs investigation; a working Streamable HTTP MCP endpoint
does not prove that its authentication or resource model fits automatically.
[Cloudflare OS architecture](https://github.com/cloudflare/cloudflare-os#gatekeepers-a-capability-based-security-layer).

For our proposed integration, simulations must remain distinguishable from
persisted task updates and actual implementation evidence. Versions, authority
and dependencies must be checked again when a deferred action executes. An
approved simulated result must not become proof that code was tested or deployed.

Todoless currently authenticates many agent actions through a person's key.
Google browser sign-in does not add MCP OAuth or a separate agent principal.
Passing an owner key to a new client would not establish least privilege. Start
with a separately authorized synthetic workspace and read-only access, then test
narrow writes. A Veloura-only collaborator must continue receiving no Grow access.
Existing Git, deployment, security and spending gates apply to execution tools
as well as task updates.

### Cost and deployment boundaries

The starter can consume a pinned upstream release without modifying core code.
It describes several Workers, optional Gatekeepers, storage and an AI Gateway
model catalog. Reuse those mechanisms if a custom integration is justified;
avoid forking a general agent platform into Todoless or HopKit.
[Cloudflare OS starter](https://github.com/cloudflare/cloudflare-os-starter).

The current $5 Workers plan is our existing infrastructure baseline, not a
guarantee that running Cloudflare OS or its models costs nothing extra. Gateway
core analytics/rate limiting are free, while inference and some logging/features
have their own charging rules. Capture the actual trial's model billing route,
execution/storage/log usage and enforced stop conditions before expanding it.
Do not assume an existing chat subscription pays for calls from another runtime.
Todoless itself continues to make no model calls for coordination.
[AI Gateway pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/).

The OS README's local quickstart uses port 8787, currently used by our signup
rehearsal. We do not need another local installation now that Synth exists.
Any later clone/install must follow the alternate-directory and account approval
rules; no install/deploy command is part of this research.

## Product hypothesis to test

Start with founders or product leads in roughly two-to-ten-person studios who
maintain multiple app/backend repositories, collaborate with contractors, and
already use coding agents. This is a recruitment hypothesis, not a measured
market size. Developers embedding a generic task API in their own SaaS are a
different buyer; defer that older hypothesis instead of combining both roadmaps.

The proposed job is: "When I return to our projects, tell me what is actually
moving, what blocks it, what I must decide, and where the evidence is. Let the
next person or agent continue without another context reconstruction."

Test three possible reasons to choose Todoless:

1. A small shared API works across the team's chosen clients and executors.
2. Project access and evidence survive a handoff between people and agents.
3. Setup and ongoing administration are materially lighter than the alternatives.

All three can fail. A polished incumbent may win on usability; Paperclip may
already cover the desired control plane; a generated Synth app may be sufficient;
customers may prefer their existing tracker. Raw task CRUD, low hosting expense
and a futuristic presentation are weak standalone reasons to switch.

The main commercial risk is spending months maintaining a platform for a problem
teams solve adequately elsewhere. Support time and trust matter alongside cloud
cost. If external adoption develops, test a managed deployment, onboarding or
support offer before introducing billing infrastructure. Do not choose a price
or add AI resale charges without a concrete buyer/service discussion.

## Small comparison experiment

Use synthetic tasks first. Prepare one identical scenario for Todoless with an
existing Codex chat, Synth with a task backend, and Paperclip or Linear using
its native workflow. Configuration and test writes need their own authorization;
the experiments below have not been executed by this research.

| Scenario | Required observation |
| --- | --- |
| Backend contract blocks an app task | Correct dependency and a clear next action, without creating duplicate cards. |
| Executor stops and another continues | The second executor can find scope, revision, progress and evidence without rereading a whole chat. |
| Two executors try the same assignment | There is an observable conflict or safe claim mechanism; no duplicate implementation is silently started. |
| Contributor proposes completion | A responsible reviewer sees evidence and can accept or return with a reason. Source complete, reviewed, deployed and verified stay distinguishable. |
| Nontechnical collaborator manages Veloura | They can understand and change permitted work while a Grow request is denied. |
| A tool proposes commit/deploy/spending | The relevant execution boundary holds; a task status or simulated success cannot authorize the action. |
| The owner skips several days | Work and context remain available without invented overdue flags or billed human hours. |

Measure setup effort, manual coordination messages, duplicate work, time needed
to resume, review clarity, access failures and observed operating cost. Record
raw observations before ranking options. Gate failures cannot be traded away for
a better overall convenience score.

## Market validation alongside the team pilot

Interview five relevant teams as a small first sample. No outreach is sent by this
checkpoint. Ask about their current work before describing Todoless:

- Show the last assignment that lost context between a person and an agent.
- Which repositories, trackers and agent clients were involved?
- What did the failure cost, and how often has it happened recently?
- What workaround do you use, and why have you kept it?
- Who must review work, and what must a contractor or agent never see or do?
- Could an existing tool solve it with a configuration change?
- If the prototype helps, will you try it on your own work and return to it?
- Who could approve paying for hosting, onboarding or support, and for what result?

For each conversation, record a recent example, workaround, severity, required
integration and an observable next commitment. Do not count "sounds useful" as
adoption. Ask permission before collecting or sharing customer artifacts.

Proposed first decision signals: three independent examples of recurring pain,
two teams willing to try their own work, and at least one repeat-use or concrete
commercial commitment. These are practical screening thresholds for a tiny sample,
not statistical validation or proof of a large market. For open-source success,
repeat outside use and useful integration feedback can justify continuation even
without an immediate paying customer.

## Revised order of work

1. **Preserve the working baseline.** Keep the team queue usable. Finish the
   outstanding Google/email CI and focused Git checkpoints separately; public
   signup activation does not need to precede product research.
2. **Review alternatives.** Use the existing Synth trial; examine Paperclip as a
   direct substitute and Linear/GitHub as the baseline. Make permissions and cost
   boundaries explicit before any connected trial. No migration or fork yet.
3. **Observe real team delivery.** Reuse a few existing Grow/Veloura cards and
   record the actual handoff and review pain. The nontechnical colleague's
   restricted access/onboarding remains a requirement, not a public-launch task.
4. **Collect outside evidence.** Run the short interviews and independent model
   reviews around available time. Skipped personal-project days do not create
   deadlines or overdue work.
5. **Choose a path.** Adopt an existing system, keep Todoless internal, build one
   missing integration, or test a narrow external product. Implement attempt/
   claim/agent-grant machinery only when a trial demonstrates the gap and its
   enforcement boundaries are specified.

Do not add a workflow builder, universal manager agent, app generator, enterprise
suite, automatic payments or broad synchronization to this learning cycle.
Wrang, bboy-kit and generator ideas remain future work.

## Independent review and next decision

Give ChatGPT and Claude the same [review packet](todoless-independent-review-packet-2026-10-30.md)
separately, before showing either the other's answer. Request current primary
sources, competing explanations, a strongest alternative and reasons to stop.
Agreement between models is not customer evidence. Model reviews have not yet
been obtained.

Compare their responses by claim, source, assumption, recommendation and cheap
disconfirming experiment. Return here with both reviews and any trial observations;
the next decision should identify one experiment and the work to defer.

The immediate recommendation is to continue Todoless for the team, evaluate Synth
and Paperclip before adding orchestration, and keep the commercial thesis
provisional. [Earlier charter](../planning/agentic-task-management-charter-2026-10-29.md).
