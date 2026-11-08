# Durable issue-to-merge workflows

Back to the [README](../README.md). Related: [Agents](agents.md), [How it works](how-it-works.md), [Configuration](configuration.md).

## Start with one authorized request

Ask the Issues agent to implement a request with acceptance criteria. After reading/filing its issues, the agent explicitly submits this handoff **only when the person authorized implementation**. Merely discovering or filing an issue does not start work.

```sh
office-workflow ready --json '{"issues":[12],"criteria":["The acceptance scenario passes"],"dependencies":[],"context":"Original authorized implementation request…","authorized":true}'
```

The office puts `office-workflow` on workers' PATH. Like `office-queue`, it uses `AGENT_OFFICE_HOOK_URL`, `AGENT_OFFICE_WORKER_ID` and `AGENT_OFFICE_HOOK_TOKEN`. Tokens never enter the journal. Role, account, floor and repository come from the authenticated worker, not payload fields. The original GitHub login is captured and later account changes block work.

One issue produces one implementation task. Decompose larger work into separately authorized issues when useful. Dependencies name other workflow issues on this floor and must reach `merged` before a dependent task is created. Unknown dependencies remain visibly waiting; worker-turn completion does not satisfy them.

## Lifecycle and commands

1. **Ready for planning.** A persisted `issues.ready` starts/resumes `station-queue`, using the configured default provider/model and originating account when absent. Busy kiosks wait. Another account's kiosk blocks delivery. Planning records its plan and acknowledgement atomically:

   ```sh
   office-workflow plan <event-id> --json '{"title":"Implement #12","prompt":"Complete standalone implementation task…"}'
   ```

   The coordinator creates the linked task idempotently; do not also call `office-queue add` for this event. Existing queue desk/concurrency/capacity/budget limits apply. Workflow worktrees verify origin/account identity, fetch `origin/main` successfully and branch from that remote commit, never local-only HEAD. Ordinary manual hires retain their existing behavior.

2. **Queued → implementing.** The worker reads repository instructions and the full issue, implements, verifies, commits/pushes and opens a PR with `Closes #12`. It records verification tied to the exact head:

   ```sh
   office-workflow complete <workflow-id> --json '{"pr":123,"head":"<full-SHA>","results":[{"command":"npm test","result":"pass","detail":"Integration cases passed"}]}'
   ```

   Reconciliation also finds PRs from the assigned branch when explicit notification was missed. Drafts wait. A worker ending its turn without a PR becomes blocked after a discovery grace period, never delivered. Missing verification is explicitly reported to the reviewer for independent verification.

3. **Awaiting review.** `pr.ready` starts/resumes `station-pulls` with repository, head, issue/task/worker and verification. The reviewer checks the diff, tests/CI, unresolved findings, repository instructions and approval/merge rules:

   ```sh
   office-workflow review <event-id> --json '{"head":"<reviewed-SHA>","decision":"changes_requested","summary":"Concrete finding and required fix…","inspected":{"diff":true,"tests":true,"instructions":true,"findings":true,"ci":true},"securityReviewed":false,"humanRequired":false}'
   ```

   Decisions: `changes_requested`, `awaiting_checks`, `needs_human`, `eligible`. Eligibility requires every inspection flag. Findings produce `review.fix` for the original implementation worker. The worker fixes, verifies/pushes and reports the new head. New heads invalidate prior eligibility and head-specific human/security approval. Changed checks can trigger same-head re-review.

4. **Merge or human escalation.** Eligibility is not merge authorization. With no human grant, `needs_human` records the exact decision required. With a grant, the coordinator rechecks current policy/head before an exact-SHA squash merge. Only GitHub's confirmed `MERGED` completes delivery.

5. **Report.** `workflow.report` returns results/blockers to Issues with the original correlation context. The agent reports to the originating request and acknowledges; fix workers likewise acknowledge `review.fix`:

   ```sh
   office-workflow ack <event-id> --json '{"outcome":"Reported the result/decision needed"}'
   ```

Existing safe leave-on-merge cleanup still decides when workers can go home and preserves undelivered work.

## Merge policy and native permissions

**Merge authorization starts off.** Implementation requests and peer messages cannot enable it. Only the originating signed-in human can grant it. The automatic gateway enforces:

- Exact current head reviewed `eligible`, all inspections recorded.
- Author `webdevcody`; other authors additionally require an explicit human PR link, reviewer security review, and human security approval of this exact reviewed head.
- Head-specific human approval when the reviewer identifies a human-required rule or decision.
- Open non-draft PR, passing checks, required reviews satisfied, no unresolved threads, and `CLEAN` merge state. Unknown protection/CI/finding data fails closed; more than 100 review threads conservatively requires human handling.
- Fresh repository/account/authority checks immediately before writing, `merge_method=squash`, and GitHub's `sha=<reviewed-head>` precondition. No admin override, auto-merge, protection bypass or shared-checkout branch deletion.

Repository instructions and GitHub protection remain authoritative. Reviewers must mark `humanRequired:true` when instructions require a human or their meaning is unresolved. Provider approvals remain visible and block work until answered. Board roles require **Discuss with agents** for automatic workflow delivery; worker completion/fix handling requires **View office state**. The feature does not install blanket approval rules or alter these defaults.

## Inspect and control

`office-workflow list` prints state, current owner, next action, blocker, timeline and events including attempts, recipients, leases and outcomes. Boards see same-account workflows; implementation workers see their linked workflows. The originating human can inspect the same JSON with their existing office session:

```
GET /api/workflows?floor=<floor-id>
```

Human controls require that session, same-origin requests and JSON:

```
POST /api/workflows?floor=<floor-id>
{"workflow":"<id>","action":"pause"}
```

| Action | Meaning / additional fields |
| --- | --- |
| `pause` | Hold new deliveries, queued-task seating and merges. Already submitted worker turns are not interrupted. |
| `resume` | Resume pending work and reconciliation. |
| `cancel` | Terminal cancellation; no new dispatch. Stop an existing worker manually if needed. |
| `retry` | Reset blocked deliveries after fixing their cause; resume a reviewer question with another same-head review. Ambiguous merges cannot be blindly retried. |
| `authorize` | Require explicit `merge:true` or `merge:false`. Optional `head` grants approval for the reviewed head. For another author also provide `linkedPr:<number>`, `head:"<reviewed-SHA>"`, `securityReviewed:true` after human security review. |
| `replace` | `task:"<id>"` explicitly links a same-account replacement task for the issue. It must have a worker and, for an existing PR, use that PR's branch. Findings go to this worker. |

Example from the originating signed-in office page's developer console:

```js
await fetch('/api/workflows?floor=<floor-id>', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ workflow: '<id>', action: 'authorize', merge: true })
}).then(r => r.json());
```

This grants workflow-scoped authority under existing rules, not broader repository authorization. Worker tokens have no human-control endpoint. A pause/cancel during GitHub preflight prevents the subsequent write; a network write already submitted cannot be recalled.

## Event contract and recovery

`workflows.json` is a versioned floor/repository-scoped journal. Events include stable ID/idempotency key, workflow correlation ID, source/target role, floor/repository/account, issue/task/worker/PR, head SHA, payload, timestamps, attempts, next retry, recipient, lease, acknowledgement and outcome. Producers persist before delivery. Inbox outcomes and new outbox entries share one atomic fsynced snapshot replacement. Queue snapshots use atomic replacement; durable workflow markers and worker-prompt recovery cover the queue/worker boundary.

Transport is **at least once**. Five-minute leases are persisted before sending. One event per role/worker lane is outstanding. Acknowledgements bind to the claimed worker/account/role; restart preserves leases. Delivery failures use bounded exponential backoff. Starting/working/needs-input agents are never idle. Five unsuccessful deliveries/acknowledgements become blocked; three fix rounds or five repeated check/re-review cycles escalate. Idempotency keys prevent duplicate plans/reviews/fixes, and effect/event history is retained.

| Situation | Recovery |
| --- | --- |
| Restart / agent exit | Workers restore first; the server reconciles queue/GitHub independently of browsers, then resumes expired/pending leases. Active turns are not pasted into. |
| Missed PR notification | Discover by assigned branch; non-draft heads emit `pr.ready`. Multiple matches require explicit completion/linking. |
| Queue/spawn succeeded but reply lost | Recover the workflow task marker or adopt the matching worker prompt, rather than spawning twice. |
| Missing sign-in / role disabled / revoked account | Inspect the blocker, restore intended credentials/permissions, retry. The pipeline never changes those settings itself. |
| Busy kiosk / native question | Wait or answer the genuine question in its terminal. Another account's kiosk must be freed/replaced with the originating account's agent. |
| Worker gone / missing PR / failed checks | Inspect the task/worker/head and next action. Resume the worker or explicitly link a replacement task. |
| Merge response lost | Read GitHub: if merged, complete once; if open/unknown, require human inspection and exact-head reauthorization. |
| Corrupt/mismatched journal / disk failure | Preserve the file; inspect the journal/API error, restore correct storage/permissions and restart the floor. No unpersisted handoff is acknowledged as successful. |

## Modules and automated verification

`src/server/workflow/` contains contract/journal/events/coordinator/policy and modular GitHub, queue, worker, hook and session-route adapters. `Floor` only installs/stops the feature. Queue admission/recovery and worktree factories are scoped registries. No orchestration is embedded in the main/server composition roots, client store or protocol.

```sh
node --import tsx --import=#tests/css --test tests/workflow.test.ts tests/workflow-boundaries.test.ts tests/workflow-worktree.test.ts
npm run typecheck
npm test
npm run build
```

Tests drive the actual durable coordinator and task queue with mocked provider/GitHub boundaries, CLI → authenticated HTTP handoffs, policy/SHA gates, crash replay, busy/absent agents, paused seating, missing PRs and local git worktree isolation. No live merges are needed. The inspection/control surface is JSON/CLI; there are no visual changes.
