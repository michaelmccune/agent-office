import { randomUUID } from 'node:crypto';
import { Journal } from './journal.js';
import { cancelOutstanding, enqueue, promptFor, report, transition } from './events.js';
import { mergeBlocker } from './policy.js';
import { terminal, type Actor, type Event, type Ports, type Review, type Verification, type Workflow } from './types.js';

const MAX_ATTEMPTS = 5;
const MAX_ROUNDS = 3;
const LEASE_MS = 5 * 60_000;
const safe = new Set(['idle', 'done', 'offline', 'exited']);

/** One coordinator/pump per floor. Agent turns only propose outcomes; this module owns durable
 * effects. Queue creation is reconciled by a persisted marker; GitHub merges use a SHA guard. */
export class WorkflowCoordinator {
  private journal: Journal;
  private running?: Promise<void>;
  private stopped = false;
  private timer?: NodeJS.Timeout;
  onShutdown = () => {};
  constructor(dir: string, private floor: string, private repository: string, private ports: Ports) {
    this.journal = new Journal(dir, floor, repository);
  }
  start() {
    if (!this.timer && !this.stopped && !this.snapshot().error) this.timer = setInterval(() => { void this.tick().catch((e) => console.error('Workflow persistence/pump:', e)); }, 2000);
  }
  shutdown() { this.stopped = true; clearInterval(this.timer); this.onShutdown(); }
  snapshot() { return this.journal.snapshot(); }

  async ready(actor: Actor, input: { issues: number[]; criteria: string[]; dependencies: number[]; context: string; authorized: boolean }) {
    if (actor.role !== 'issues') throw new Error('Only the Issues station can mark issues ready');
    this.permission(actor);
    if (!this.repository || !input.authorized) throw new Error('Explicit implementation authorization from the originating request is required');
    if (!Array.isArray(input.issues) || !input.issues.length || input.issues.length > 20 || input.issues.some((i) => !Number.isSafeInteger(i) || i < 1)) throw new Error('Give 1–20 positive issue numbers');
    if (!Array.isArray(input.criteria) || !input.criteria.length || input.criteria.some((s) => typeof s !== 'string' || !s.trim()) || typeof input.context !== 'string' || !input.context.trim()) throw new Error('Original request context and acceptance criteria are required');
    if (!Array.isArray(input.dependencies) || input.dependencies.some((d) => !Number.isSafeInteger(d) || d < 1 || input.issues.includes(d))) throw new Error('Dependencies must be other positive issue numbers');
    const githubLogin = await this.ports.identity(actor.owner);
    this.permission(actor);
    this.journal.commit((data) => {
      for (const issue of new Set(input.issues)) {
        const existing = data.workflows.find((w) => w.issue === issue);
        if (existing) { if (existing.owner !== actor.owner) throw new Error('Issue is already authorized by another account'); continue; }
        const now = this.ports.now();
        const w: Workflow = { id: randomUUID(), floor: this.floor, repository: this.repository, issue, owner: actor.owner, githubLogin,
          context: input.context, criteria: input.criteria, dependencies: [...new Set(input.dependencies)],
          state: 'ready_for_planning', currentOwner: 'queue', nextAction: 'Queue/Planning must submit a plan', paused: false,
          authority: { merge: false }, round: 0, reviewCycle: 0, createdAt: now, updatedAt: now,
          timeline: [{ at: now, state: 'ready_for_planning', detail: `Implementation authorized by Issues station ${actor.id} for ${actor.owner ?? 'office account'}; merge authority disabled` }] };
        data.workflows.push(w);
        transition(w, w.state, 'queue', 'Queue/Planning must submit a plan', now);
        enqueue(data, w, 'issues.ready', 'queue', `${w.id}:plan`, 'Plan the authorized issue. Dependencies must merge before implementation starts.', now);
      }
    });
    return this.snapshot();
  }

  plan(actor: Actor, eventId: string, plan: { title: string; prompt: string }) {
    if (typeof plan.title !== 'string' || !plan.title.trim() || typeof plan.prompt !== 'string' || !plan.prompt.trim()) throw new Error('Plan needs title and implementation prompt');
    this.finish(actor, eventId, 'issues.ready', (w, _e) => {
      w.plan = plan;
      transition(w, 'queued', 'coordinator', 'Create linked task after dependencies merge', this.ports.now());
    });
  }
  ack(actor: Actor, eventId: string, outcome: string) {
    if (typeof outcome !== 'string' || !outcome.trim()) throw new Error('Record an outcome');
    const event = this.event(eventId);
    if (!['review.fix', 'workflow.report'].includes(event.type)) throw new Error('Use plan or review to record this event outcome');
    this.finish(actor, eventId, event.type, () => {}, outcome);
  }
  review(actor: Actor, eventId: string, review: Review) {
    if (!review || !['changes_requested', 'awaiting_checks', 'needs_human', 'eligible'].includes(review.decision) || typeof review.summary !== 'string' || !review.summary.trim() || typeof review.head !== 'string' || typeof review.humanRequired !== 'boolean' || typeof review.securityReviewed !== 'boolean') throw new Error('Review needs decision, summary, exact head and explicit securityReviewed/humanRequired booleans');
    const event = this.event(eventId);
    const workflow = this.workflow(event.workflow);
    if (event.head !== review.head || workflow.head !== review.head) throw new Error('Stale reviewed head: review the current head');
    if (review.decision === 'eligible' && (!review.inspected || !['diff', 'tests', 'instructions', 'findings', 'ci'].every((k) => review.inspected[k as keyof Review['inspected']] === true))) throw new Error('Eligibility requires inspecting diff, tests, instructions, findings and CI');
    this.finish(actor, eventId, 'pr.ready', (w, _e, data) => {
      const now = this.ports.now();
      w.review = review;
      if (review.decision === 'changes_requested') {
        w.round++;
        if (w.round > MAX_ROUNDS) {
          transition(w, 'needs_human', 'human', 'Review/fix limit reached; decide whether to create a linked replacement task', now);
          report(data, w, now);
        } else {
          transition(w, 'changes_requested', 'worker', review.summary, now);
          enqueue(data, w, 'review.fix', 'worker', `${w.id}:fix:${review.head}`, review.summary, now);
        }
      } else if (review.decision === 'awaiting_checks') transition(w, 'awaiting_checks', 'coordinator', 'Wait for checks then re-review the current head', now);
      else if (review.decision === 'needs_human') { transition(w, 'needs_human', 'human', review.summary, now); report(data, w, now); }
      else transition(w, 'awaiting_review', 'coordinator', 'Recheck merge policy and reviewed head', now);
    }, review.summary);
  }

  /** Completion is linked to the exact worker/task/head; discovery recovers missing notifications. */
  complete(actor: Actor, id: string, input: { pr: number; head: string; results: Verification[] }) {
    const w = this.workflow(id);
    this.bound(actor, w);
    if (actor.role !== 'worker' || actor.id !== w.worker || !Number.isSafeInteger(input.pr) || input.pr < 1 || !/^[a-f\d]{40,64}$/i.test(input.head)) throw new Error('Completion must name your linked task PR and exact head');
    if (!Array.isArray(input.results) || !input.results.length || input.results.some((v) => !v || typeof v.command !== 'string' || !v.command.trim() || !['pass', 'fail'].includes(v.result) || typeof v.detail !== 'string')) throw new Error('Completion needs verification command/result/detail records');
    this.journal.commit((data) => {
      const live = data.workflows.find((x) => x.id === id)!;
      if (live.pr && live.pr !== input.pr) throw new Error('Completion PR differs from the discovered task PR');
      live.pr = input.pr;
      live.verification = { head: input.head, results: input.results };
      live.lastPoll = undefined;
    });
  }

  /** Only called by a signed-in human route, with the originating account identity. */
  control(owner: string | undefined, id: string, action: string, input: { merge?: boolean; head?: string; linkedPr?: number; securityReviewed?: boolean; task?: string } = {}) {
    const w = this.workflow(id);
    if (w.owner !== owner) throw new Error('Only the originating account can control this workflow');
    if (terminal(w)) throw new Error('Workflow is terminal; no further dispatch');
    this.journal.commit((data) => {
      const live = data.workflows.find((x) => x.id === id)!;
      const now = this.ports.now();
      if (action === 'pause') { live.paused = true; live.timeline.push({ at: now, state: live.state, detail: 'Paused by originating human' }); }
      else if (action === 'resume') { live.paused = false; live.lastPoll = undefined; live.timeline.push({ at: now, state: live.state, detail: 'Resumed by originating human' }); }
      else if (action === 'cancel') {
        live.paused = true; cancelOutstanding(data, live);
        transition(live, 'cancelled', 'human', 'Cancelled: no further coordinator dispatch; existing worker turns may still run', now);
      } else if (action === 'retry') {
        live.blocker = undefined; live.lastPoll = undefined;
        live.failures = 0; live.retryAt = undefined;
        for (const e of data.events) if (e.workflow === id && e.state === 'blocked') { e.state = 'pending'; e.attempts = 0; e.nextAt = now; }
        // Ambiguous merge needs explicit human reauthorization, never a blind automatic replay.
        if (live.mergeIntent) throw new Error('Ambiguous merge: inspect GitHub then use authorize with the exact reviewed head');
        if (live.review?.decision === 'needs_human' || live.round > MAX_ROUNDS || live.reviewCycle >= 5) {
          live.review = undefined; live.reviewCycle++; live.round = 0;
        }
        transition(live, live.pr ? 'awaiting_review' : live.plan ? 'queued' : 'ready_for_planning', 'coordinator', 'Retry requested by originating human', now);
      } else if (action === 'replace') {
        const task = this.ports.tasks().find((t) => t.id === input.task);
        if (!task || task.owner !== owner || task.issue !== live.issue || !task.workerId) throw new Error('Replacement must be a same-account task for this issue with an implementation worker');
        if (live.pr && task.branch !== live.branch) throw new Error('Replacement must work on the existing PR branch');
        live.task = task.id; live.worker = task.workerId; live.branch = task.branch;
        cancelOutstanding(data, live, 'review.fix');
        if (live.review?.decision === 'changes_requested') enqueue(data, live, 'review.fix', 'worker', `${id}:replacement:${task.id}:${live.head}`, live.review.summary, now);
        live.lastPoll = undefined; live.blocker = undefined;
        transition(live, live.pr ? 'changes_requested' : 'implementing', 'worker', 'Human linked replacement implementation task', now);
      } else if (action === 'authorize') {
        if (typeof input.merge !== 'boolean') throw new Error('Explicit merge:true or merge:false is required');
        if (input.head && input.head !== live.review?.head) throw new Error('Human approval must name the reviewed head');
        if (input.securityReviewed && (!input.head || input.linkedPr !== live.pr)) throw new Error('Security approval needs explicit linkedPr and reviewed head');
        if (input.linkedPr !== undefined && input.linkedPr !== live.pr) throw new Error('Explicit PR link must name this workflow PR');
        live.authority = { merge: input.merge, approvedHead: input.head, linkedPr: input.linkedPr, securityHead: input.securityReviewed === true ? input.head : undefined, grantedAt: now, grantedBy: owner ?? 'office session' };
        if (live.review?.decision === 'needs_human') { live.review = undefined; live.reviewCycle++; }
        live.mergeIntent = undefined; live.lastPoll = undefined;
        transition(live, live.pr ? 'awaiting_review' : live.state, 'coordinator', `Human authority: merge=${input.merge}; approved head=${input.head ?? 'none'}; linked PR=${input.linkedPr ?? 'none'}; security reviewed=${input.securityReviewed === true}. Existing policy still applies.`, now);
      } else throw new Error('Unknown workflow control');
    });
  }

  tick(): Promise<void> {
    if (this.running) return this.running;
    if (this.stopped) return Promise.resolve();
    this.running = this.pump().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async pump() {
    for (const saved of this.snapshot().workflows) {
      if (this.stopped || terminal(saved) || saved.paused) continue;
      if ((saved.failures ?? 0) >= MAX_ATTEMPTS || (saved.retryAt ?? 0) > this.ports.now()) continue;
      try {
        const denied = this.ports.permitted(saved.owner, 'queue');
        if (denied) throw new Error(denied);
        this.reconcileTask(saved.id);
        const w = this.workflow(saved.id);
        if (w.task && (!w.lastPoll || this.ports.now() - w.lastPoll >= 15_000)) {
          const pull = w.pr ? await this.ports.pull(w) : await this.ports.discover(w);
          if (!this.active(w.id)) continue;
          this.journal.commit((data) => { data.workflows.find((x) => x.id === w.id)!.lastPoll = this.ports.now(); });
          if (pull) await this.observe(w.id, pull);
          else if (w.finishedTurnAt && !this.ports.workerActive?.(w.worker ?? '') && this.ports.now() - w.finishedTurnAt >= 30_000) this.block(w.id, 'Worker turn ended without a PR. Inspect the worker, then retry or queue a linked replacement.');
        }
      } catch (error) {
        this.journal.commit((data) => {
          const w = data.workflows.find((x) => x.id === saved.id)!;
          w.failures = (w.failures ?? 0) + 1;
          w.retryAt = this.ports.now() + Math.min(60_000, 1000 * 2 ** w.failures);
        });
        this.block(saved.id, (error as Error).message);
      }
    }
    if (!this.stopped) this.dispatch();
  }

  private reconcileTask(id: string) {
    let w = this.workflow(id);
    if (!w.plan) return;
    const missing = w.dependencies.filter((issue) => !this.snapshot().workflows.some((d) => d.issue === issue && d.state === 'merged'));
    if (!w.task && missing.length) {
      this.journal.commit((data) => transition(data.workflows.find((x) => x.id === id)!, 'queued', 'coordinator', `Waiting for dependency issues ${missing.join(', ')} to merge`, this.ports.now()));
      return;
    }
    const task = w.task ? this.ports.tasks().find((t) => t.id === w.task) : this.ports.ensureTask(w, this.implementationPrompt(w));
    if (!task) throw new Error('Linked queue task was removed; inspect and create an explicitly linked replacement');
    this.journal.commit((data) => {
      w = data.workflows.find((x) => x.id === id)!;
      w.task = task.id; w.worker = task.workerId; w.branch = task.branch;
      if (w.pr) return;
      if (task.status === 'running') transition(w, 'implementing', task.workerId ?? 'worker', 'Implement, verify, open a linked PR and report completion', this.ports.now());
      if (task.status === 'done') {
        if (task.outcome === 'failed' || task.outcome === 'killed') throw new Error(task.error ?? `Implementation ${task.outcome}`);
        // The office queue marks restored turns exited. Keep following its restored worker/branch.
        w.finishedTurnAt ??= this.ports.now();
      }
    });
  }

  private async observe(id: string, pull: import('./types.js').Pull) {
    let w = this.workflow(id);
    if (w.pr && w.pr !== pull.number) throw new Error('PR discovery identity changed');
    if (w.branch && pull.branch !== w.branch) throw new Error('PR branch differs from assigned implementation branch');
    this.journal.commit((data) => {
      w = data.workflows.find((x) => x.id === id)!;
      w.pr = pull.number;
      const now = this.ports.now();
      if (pull.state === 'MERGED') {
        transition(w, 'merged', 'issues', `PR #${pull.number} merged; report to originating Issues request`, now);
        cancelOutstanding(data, w); report(data, w, now); return;
      }
      if (pull.state === 'CLOSED') {
        transition(w, 'failed', 'issues', `PR #${pull.number} closed without merging`, now);
        cancelOutstanding(data, w); report(data, w, now); return;
      }
      if (w.head !== pull.head) {
        w.head = pull.head; w.review = undefined; w.reviewCycle = 0; w.authority.approvedHead = undefined; w.authority.securityHead = undefined;
        cancelOutstanding(data, w, 'pr.ready'); cancelOutstanding(data, w, 'review.fix');
      }
      if (pull.draft) { transition(w, 'implementing', 'worker', `PR #${pull.number} is draft; mark ready when verification is complete`, now); return; }
      const exhausted = data.events.find((e) => e.workflow === id && e.head === pull.head && e.type === 'pr.ready' && e.state === 'blocked');
      if (exhausted) { w.blocker = exhausted.outcome ?? 'Review delivery exhausted'; transition(w, 'blocked', 'human', w.blocker, now); return; }
      if (w.review?.decision === 'changes_requested' || w.state === 'needs_human' && w.round > MAX_ROUNDS) return;
      if (w.review?.decision === 'needs_human') return;
      if (w.review?.decision === 'awaiting_checks' && pull.checks === 'pending') return;
      if (w.review?.decision === 'awaiting_checks' || w.review?.decision === 'eligible' && pull.checks !== 'pass') {
        if (w.reviewCycle >= 5) { transition(w, 'needs_human', 'human', 'Check/re-review limit reached; inspect CI before retrying', now); report(data, w, now); return; }
        w.review = undefined; w.reviewCycle++;
      }
      if (w.review?.decision !== 'eligible') {
        transition(w, 'awaiting_review', 'pulls', `Review PR #${pull.number} at head ${pull.head}`, now);
        enqueue(data, w, 'pr.ready', 'pulls', `${id}:review:${pull.head}:${w.reviewCycle}`, JSON.stringify({ pull, verification: w.verification ?? 'Worker did not report verification; reviewer must verify independently' }), now);
      }
    });
    w = this.workflow(id);
    if (terminal(w) || pull.draft || w.review?.decision !== 'eligible') return;
    if (w.mergeIntent) { this.human(id, 'Merge outcome is ambiguous; inspect GitHub before reauthorizing this exact head'); return; }
    const blocked = mergeBlocker(w, pull);
    if (blocked) { this.human(id, blocked); return; }
    const denied = this.ports.permitted(w.owner, 'pulls');
    if (denied) { this.human(id, denied); return; }
    // Persist the intent first. If the server dies after GitHub accepts it, the next read reconciles
    // MERGED; an OPEN/unknown result is escalated instead of repeating a potentially completed write.
    this.journal.commit((data) => { data.workflows.find((x) => x.id === id)!.mergeIntent = pull.head; });
    if (!this.active(id)) return;
    await this.ports.merge(this.workflow(id), pull.head);
    // Never claim delivery merely because a merge command returned: only GitHub MERGED completes it.
    const confirmed = await this.ports.pull(this.workflow(id));
    if (confirmed.state === 'MERGED') await this.observe(id, confirmed);
    else this.human(id, 'Merge unconfirmed; inspect GitHub and reauthorize after resolving protections');
  }

  private dispatch() {
    const held = new Set<string>();
    for (const snapshot of this.snapshot().events) {
      if (this.stopped) return;
      const w = this.workflow(snapshot.workflow);
      if (w.paused || w.state === 'cancelled' || ['acknowledged', 'blocked', 'cancelled'].includes(snapshot.state)) continue;
      const lane = snapshot.target === 'worker' ? `worker:${snapshot.worker}` : snapshot.target;
      if (held.has(lane)) continue;
      held.add(lane);
      const recipient = this.ports.recipient(snapshot.target, snapshot.worker);
      const now = this.ports.now();
      if (snapshot.state === 'leased' && snapshot.leaseUntil! > now) continue;
      if (snapshot.nextAt > now) continue;
      if (recipient && !safe.has(recipient.status)) {
        if (recipient.status === 'needs_input') this.block(w.id, `Recipient ${recipient.id} needs human input; answer its native approval/question, then resume`);
        continue;
      }
      const denied = this.ports.permitted(w.owner, snapshot.target) ?? (recipient && recipient.owner !== w.owner ? 'Station belongs to another account; free its kiosk or use a same-account station' : undefined);
      if (denied || snapshot.attempts >= MAX_ATTEMPTS) {
        this.journal.commit((data) => { const e = data.events.find((x) => x.id === snapshot.id)!; e.state = 'blocked'; e.outcome = denied ?? 'Delivery/ack retries exhausted'; });
        this.block(w.id, denied ?? 'Delivery/ack retries exhausted; inspect the recipient and retry'); continue;
      }
      this.journal.commit((data) => {
        const e = data.events.find((x) => x.id === snapshot.id)!;
        e.attempts++; e.state = 'leased'; e.leaseUntil = now + LEASE_MS; e.updatedAt = now;
        e.recipient = recipient?.id;
      });
      try {
        const event = this.event(snapshot.id);
        const recipientId = this.ports.deliver(event, promptFor(event, w));
        this.journal.commit((data) => { data.events.find((x) => x.id === snapshot.id)!.recipient = recipientId; });
      } catch (error) {
        this.journal.commit((data) => {
          const e = data.events.find((x) => x.id === snapshot.id)!;
          e.state = 'pending'; e.nextAt = now + Math.min(60_000, 1000 * 2 ** e.attempts); e.outcome = (error as Error).message;
        });
      }
    }
  }

  private finish(actor: Actor, eventId: string, type: Event['type'], apply: (w: Workflow, e: Event, data: import('./types.js').Snapshot) => void, outcome = 'Outcome recorded') {
    const e = this.event(eventId), w = this.workflow(e.workflow);
    this.permission(actor);
    if (w.owner !== actor.owner || w.paused || (terminal(w) && type !== 'workflow.report')) throw new Error('Workflow account mismatch, paused or terminal');
    if (e.target !== actor.role || e.type !== type || e.recipient !== actor.id) throw new Error('Handoff is assigned to another role/recipient');
    if (e.state === 'acknowledged') return;
    if (e.state !== 'leased' || e.leaseUntil! < this.ports.now()) throw new Error('Claim expired; wait for a redelivery');
    this.journal.commit((data) => {
      const live = data.events.find((x) => x.id === e.id)!;
      apply(data.workflows.find((x) => x.id === w.id)!, live, data);
      live.state = 'acknowledged'; live.updatedAt = this.ports.now(); live.outcome = outcome;
    });
  }
  private bound(actor: Actor, w: Workflow) {
    this.permission(actor);
    if (w.owner !== actor.owner) throw new Error('Originating account mismatch');
    if (w.paused || terminal(w)) throw new Error('Workflow is paused or terminal');
  }
  private permission(actor: Actor) { const why = this.ports.permitted(actor.owner, actor.role); if (why) throw new Error(why); }
  private active(id: string) { const w = this.workflow(id); return !this.stopped && !w.paused && !terminal(w); }
  private event(id: string) { const e = this.snapshot().events.find((x) => x.id === id); if (!e) throw new Error('Unknown event'); return e; }
  private workflow(id: string) { const w = this.snapshot().workflows.find((x) => x.id === id); if (!w) throw new Error('Unknown workflow'); return w; }
  private block(id: string, reason: string) {
    if (!this.active(id)) return;
    this.journal.commit((data) => {
      const w = data.workflows.find((x) => x.id === id)!;
      w.blocker = reason; transition(w, 'blocked', 'human', reason, this.ports.now()); report(data, w, this.ports.now());
    });
  }
  private human(id: string, reason: string) {
    this.journal.commit((data) => {
      const w = data.workflows.find((x) => x.id === id)!;
      w.blocker = reason; transition(w, 'needs_human', 'human', reason, this.ports.now()); report(data, w, this.ports.now());
    });
  }
  private implementationPrompt(w: Workflow) {
    return [w.plan!.prompt, `Repository ${w.repository}; issue #${w.issue}. Read AGENTS.md and full issue acceptance criteria.`,
      `Original request: ${w.context}`, `Acceptance criteria:\n${w.criteria.join('\n')}`,
      'Use your assigned isolated worktree. Verify with repository-required checks, commit, push, and open a PR with Closes #' + w.issue + '.',
      `Report structured completion: office-workflow complete ${w.id} --json '{"pr":123,"head":"<exact SHA>","results":[{"command":"…","result":"pass","detail":"…"}]}'. Missing PRs are blocked, never successful delivery.`,
      `<!-- office-workflow:${w.id} -->`].join('\n\n');
  }
}
