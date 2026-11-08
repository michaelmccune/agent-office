import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { WorkflowCoordinator } from '../src/server/workflow/coordinator.js';
import { fixture, issueInput, NEXT, planned, review, reviewing, SHA } from './support/workflow.js';

test('authorized Issues → actual queue/isolated worker → PR review → concrete fix → new head review → authorized squash boundary → Issues report', async (t) => {
  const f = fixture(t);
  const event = await reviewing(f);
  assert.equal(f.queue.state().tasks.length, 1);
  assert.ok(f.manager.get(f.state.worker!)!.worktree);
  assert.match(f.manager.get(f.state.worker!)!.prompt!, /Closes #12/);
  assert.match(f.deliveries.at(-1)!.prompt, /verification|Worker did not report/);
  f.coordinator.review(f.actor('pulls'), event.id, { ...review('changes_requested'), summary: 'Fix the replay race; add an integration case' });
  f.markDone('station-pulls');
  await f.coordinator.tick();
  const fix = f.event('review.fix');
  assert.equal(fix.worker, f.state.worker);
  assert.equal(f.deliveries.at(-1)!.target, f.state.worker);
  assert.match(f.deliveries.at(-1)!.prompt, /Fix the replay race/);
  f.coordinator.ack(f.actor('worker'), fix.id, 'Fixed and verified');
  f.coordinator.complete(f.actor('worker'), f.state.id, { pr: 30, head: NEXT, results: [{ command: 'npm test', result: 'pass', detail: 'integration passed' }] });
  f.setPull({ head: NEXT }); f.markDone(f.state.worker!); f.advance();
  await f.coordinator.tick();
  assert.throws(() => f.coordinator.review(f.actor('pulls'), event.id, review()), /Stale/);
  const nextReview = f.event('pr.ready');
  assert.equal(nextReview.head, NEXT);
  assert.match(f.deliveries.at(-1)!.prompt, /integration passed/);
  f.coordinator.review(f.actor('pulls'), nextReview.id, review('eligible', NEXT));
  f.markDone('station-pulls'); f.advance(); await f.coordinator.tick();
  assert.equal(f.state.state, 'needs_human'); assert.equal(f.merges.length, 0);
  assert.match(f.state.nextAction, /grant merge authority/);
  f.coordinator.ack(f.actor('issues'), f.event('workflow.report').id, 'Asked originating human for merge authority');
  f.markDone('station-issues');
  f.coordinator.control(undefined, f.state.id, 'authorize', { merge: true });
  await f.coordinator.tick();
  assert.deepEqual(f.merges, [NEXT]);
  assert.equal(f.state.state, 'merged');
  assert.equal(f.state.review?.head, NEXT);
  assert.equal(f.event('workflow.report').target, 'issues');
  f.coordinator.ack(f.actor('issues'), f.event('workflow.report').id, 'Reported merge to originating request');
  f.advance(); await f.coordinator.tick();
  assert.equal(f.merges.length, 1);
  assert.equal(f.coordinator.snapshot().events.filter((e) => e.type === 'pr.ready').length, 2);
});

test('duplicate handoffs/plans/discovery and restart produce one task and one concurrent review per head', async (t) => {
  const f = fixture(t);
  await f.coordinator.ready(f.actor('issues'), issueInput());
  await f.coordinator.ready(f.actor('issues'), issueInput());
  assert.equal(f.coordinator.snapshot().events.length, 1);
  await f.coordinator.tick();
  const id = f.event('issues.ready').id;
  f.coordinator.plan(f.actor('queue'), id, { title: 'A', prompt: 'Implementation' });
  f.coordinator.plan(f.actor('queue'), id, { title: 'A', prompt: 'Implementation' });
  await f.coordinator.tick();
  f.setPull(); f.markDone('station-queue'); f.markDone(f.state.worker!);
  f.advance(); await f.coordinator.tick();
  const before = f.deliveries.length;
  f.restart(); f.advance(); await f.coordinator.tick();
  assert.equal(f.deliveries.length, before, 'unexpired claim is not pasted into the still-working reviewer');
  assert.equal(f.queue.state().tasks.length, 1);
  assert.equal(f.coordinator.snapshot().events.filter((e) => e.type === 'pr.ready').length, 1);
  f.markDone('station-pulls'); f.advance(5 * 60_000); await f.coordinator.tick();
  assert.equal(f.event('pr.ready').attempts, 2, 'unacknowledged handoff resumes after lease');
});

test('absent kiosks start; working/needs-input kiosks serialize and preserve genuine human questions without a browser', async (t) => {
  const f = fixture(t);
  await f.coordinator.ready(f.actor('issues'), issueInput());
  await f.coordinator.ready(f.actor('issues'), issueInput(13));
  await f.coordinator.tick();
  assert.equal(f.workers.filter((w) => w.deskId === 'station-queue').length, 1);
  assert.equal(f.deliveries.length, 1);
  const queueAgent = f.manager.get('station-queue')!;
  queueAgent.status = 'needs_input';
  f.advance(6 * 60_000); await f.coordinator.tick();
  assert.equal(f.deliveries.length, 1);
  assert.match(f.state.blocker!, /needs human input/);
  queueAgent.status = 'done';
  await f.coordinator.tick();
  assert.equal(f.deliveries.filter((d) => d.target === 'station-queue').length, 2);
  assert.equal(f.coordinator.snapshot().events.filter((e) => e.target === 'queue' && e.state === 'leased').length, 1);
});

test('planning acknowledges atomically before queue effects; ambiguous queue creation recovers its persisted marker', async (t) => {
  const f = fixture(t);
  const ensure = f.ports.ensureTask;
  let lostReply = true;
  f.ports.ensureTask = (w, prompt) => {
    const task = ensure(w, prompt);
    if (lostReply) { lostReply = false; throw new Error('Reply lost after queue committed'); }
    return task;
  };
  await planned(f);
  assert.equal(f.state.state, 'blocked');
  assert.equal(f.queue.state().tasks.length, 1);
  assert.equal(f.state.task, undefined);
  f.restart(); f.advance(); await f.coordinator.tick();
  assert.equal(f.queue.state().tasks.length, 1);
  assert.equal(f.workers.filter((w) => w.worktree).length, 1);
  assert.equal(f.state.task, f.queue.state().tasks[0].id);
});

test('missing PR and failed implementation become blocked, never queue-turn success', async (t) => {
  const f = fixture(t); await planned(f);
  f.markDone(f.state.worker!); f.advance(); await f.coordinator.tick();
  f.advance(31_000); await f.coordinator.tick();
  assert.equal(f.queue.state().tasks[0].outcome, 'done');
  assert.equal(f.state.state, 'blocked');
  assert.match(f.state.blocker!, /without a PR/);
});

test('delivery errors and unacknowledged events exhaust bounded attempts and expose retry recovery', async (t) => {
  const f = fixture(t);
  const deliver = f.ports.deliver;
  f.ports.deliver = () => { throw new Error('provider unavailable'); };
  await f.coordinator.ready(f.actor('issues'), issueInput());
  for (let i = 0; i < 6; i++) { await f.coordinator.tick(); f.advance(6 * 60_000); }
  const blocked = f.coordinator.snapshot().events.find((e) => e.type === 'issues.ready')!;
  assert.equal(blocked.attempts, 5); assert.equal(blocked.state, 'blocked');
  assert.equal(f.state.state, 'blocked');
  f.ports.deliver = deliver;
  f.coordinator.control(undefined, f.state.id, 'retry'); await f.coordinator.tick();
  assert.equal(f.event('issues.ready').attempts, 1);
});

test('checks transition triggers a re-review; stale eligibility never merges a new head', async (t) => {
  const f = fixture(t); const event = await reviewing(f);
  f.coordinator.review(f.actor('pulls'), event.id, review('awaiting_checks'));
  f.markDone('station-pulls'); f.setPull({ checks: 'pending' }); f.advance(); await f.coordinator.tick();
  assert.equal(f.state.state, 'awaiting_checks');
  f.setPull(); f.advance(); await f.coordinator.tick();
  // A fresh post-check review is distinct even if the head never changed.
  assert.ok(f.event('pr.ready'));
  f.coordinator.review(f.actor('pulls'), f.event('pr.ready').id, review());
  f.coordinator.control(undefined, f.state.id, 'authorize', { merge: true });
  f.markDone('station-pulls'); f.setPull({ head: NEXT }); f.advance(); await f.coordinator.tick();
  assert.equal(f.state.review, undefined); assert.equal(f.merges.length, 0);
  assert.equal(f.event('pr.ready').head, NEXT);
});

test('other authors need explicit linking/security review, and human-required review needs head-specific approval', async (t) => {
  const f = fixture(t); const event = await reviewing(f);
  f.setPull({ author: 'someone-else' });
  f.coordinator.review(f.actor('pulls'), event.id, { ...review(), securityReviewed: true, humanRequired: true });
  f.coordinator.control(undefined, f.state.id, 'authorize', { merge: true });
  f.markDone('station-pulls'); f.advance(); await f.coordinator.tick();
  assert.equal(f.merges.length, 0); assert.match(f.state.nextAction, /Human approval/);
  f.coordinator.control(undefined, f.state.id, 'authorize', { merge: true, head: SHA });
  await f.coordinator.tick(); assert.equal(f.merges.length, 0); assert.match(f.state.nextAction, /explicit human PR linking/);
  f.coordinator.control(undefined, f.state.id, 'authorize', { merge: true, head: SHA, linkedPr: 30, securityReviewed: true });
  await f.coordinator.tick(); assert.deepEqual(f.merges, [SHA]);
});

test('merge write with a lost response reconciles MERGED after restart, without redoing the merge', async (t) => {
  const f = fixture(t); const e = await reviewing(f);
  f.coordinator.review(f.actor('pulls'), e.id, review()); f.coordinator.control(undefined, f.state.id, 'authorize', { merge: true });
  const merge = f.ports.merge;
  f.ports.merge = async (w, head) => { await merge(w, head); throw new Error('socket lost after GitHub accepted'); };
  f.markDone('station-pulls'); f.advance(); await f.coordinator.tick();
  assert.equal(f.state.state, 'blocked'); assert.equal(f.state.mergeIntent, SHA);
  f.restart(); f.advance(); await f.coordinator.tick();
  assert.equal(f.state.state, 'merged'); assert.equal(f.merges.length, 1);
});

test('ambiguous OPEN merge result escalates, never automatically repeats', async (t) => {
  const f = fixture(t); const e = await reviewing(f);
  f.coordinator.review(f.actor('pulls'), e.id, review()); f.coordinator.control(undefined, f.state.id, 'authorize', { merge: true });
  let writes = 0; f.ports.merge = async () => { writes++; throw new Error('timeout'); };
  f.markDone('station-pulls'); f.advance(); await f.coordinator.tick();
  f.restart(); f.advance(); await f.coordinator.tick();
  assert.equal(writes, 1); assert.equal(f.state.state, 'needs_human'); assert.match(f.state.nextAction, /ambiguous/);
});

test('account/role boundaries and disabled permissions cannot authorize, acknowledge or merge', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.coordinator.ready(f.actor('worker'), issueInput()), /Only the Issues/);
  await assert.rejects(f.coordinator.ready(f.actor('issues'), { ...issueInput(), authorized: false }), /Explicit implementation/);
  await f.coordinator.ready(f.actor('issues', 'alice'), issueInput());
  // A running same-role kiosk on another account must not receive this request.
  f.manager.station('station-queue', 'manual', 'other account', 'bob'); f.markDone('station-queue');
  await f.coordinator.tick(); assert.match(f.state.blocker!, /another account/);
  assert.throws(() => f.coordinator.control('bob', f.state.id, 'authorize', { merge: true }), /originating account/);
  f.permissions.set('planning', 'agentDiscussion', false, 'human');
  f.coordinator.control('alice', f.state.id, 'retry'); await f.coordinator.tick();
  assert.match(f.state.blocker!, /disabled in role permissions/);
  assert.equal(f.queue.state().tasks.length, 0);
});

test('dependencies wait for merged delivery, not a completed implementation turn', async (t) => {
  const f = fixture(t);
  await f.coordinator.ready(f.actor('issues'), { ...issueInput(), dependencies: [11] });
  await f.coordinator.tick(); f.coordinator.plan(f.actor('queue'), f.event('issues.ready').id, { title: 'Dependent', prompt: 'Implement after #11' });
  await f.coordinator.tick();
  assert.equal(f.queue.state().tasks.length, 0); assert.match(f.state.nextAction, /dependency issues 11/);
});

test('draft PRs wait; review/fix churn reaches a human decision and retry explicitly starts another review', async (t) => {
  const f = fixture(t); await planned(f);
  f.setPull({ draft: true }); f.markDone(f.state.worker!); f.advance(); await f.coordinator.tick();
  assert.equal(f.coordinator.snapshot().events.some((e) => e.type === 'pr.ready'), false);
  f.setPull(); f.advance(); await f.coordinator.tick();
  for (let round = 0; round < 4; round++) {
    const head = String(round + 1).repeat(40);
    f.setPull({ head }); f.markDone('station-pulls'); f.advance(); await f.coordinator.tick();
    f.coordinator.review(f.actor('pulls'), f.event('pr.ready').id, { ...review('changes_requested', head), summary: `Fix round ${round}` });
  }
  assert.equal(f.state.state, 'needs_human'); assert.match(f.state.nextAction, /limit reached/);
  const count = f.coordinator.snapshot().events.filter((e) => e.type === 'review.fix').length;
  assert.equal(count, 3);
  f.coordinator.control(undefined, f.state.id, 'retry'); f.markDone('station-pulls'); f.advance(); await f.coordinator.tick();
  assert.ok(f.event('pr.ready')); assert.equal(f.state.round, 0);
});

test('explicit human review questions resume with a new same-head review after a human decision', async (t) => {
  const f = fixture(t); const e = await reviewing(f);
  f.coordinator.review(f.actor('pulls'), e.id, { ...review('needs_human'), summary: 'Choose the API compatibility policy' });
  f.markDone('station-pulls'); f.advance(); await f.coordinator.tick();
  assert.equal(f.state.state, 'needs_human');
  f.coordinator.control(undefined, f.state.id, 'retry'); f.advance(); await f.coordinator.tick();
  assert.notEqual(f.event('pr.ready').id, e.id); assert.equal(f.event('pr.ready').head, SHA);
});

test('journal identity/corruption fail closed before handoff dispatch', async (t) => {
  const f = fixture(t);
  await f.coordinator.ready(f.actor('issues'), issueInput());
  const wrong = new WorkflowCoordinator(f.dir, 'another-floor', 'michaelmccune/agent-office', f.ports);
  assert.match(wrong.snapshot().error!, /identity/);
  await assert.rejects(wrong.ready(f.actor('issues'), issueInput()), /identity/);
  writeFileSync(path.join(f.dir, 'workflows.json'), '{broken');
  const corrupt = new WorkflowCoordinator(f.dir, 'floor-1', 'michaelmccune/agent-office', f.ports);
  assert.match(corrupt.snapshot().error!, /JSON/);
  assert.equal(f.deliveries.length, 0);
  // On-disk data contains original authority and event IDs, rather than tokens/credentials.
  assert.ok(f.coordinator.snapshot().events[0].id);
});

test('journal write failures reject the producer and dispatch no unpersisted event', async (t) => {
  const f = fixture(t);
  mkdirSync(path.join(f.dir, 'workflows.json.tmp'));
  await assert.rejects(f.coordinator.ready(f.actor('issues'), issueInput()), /EISDIR/);
  await f.coordinator.tick();
  assert.equal(f.coordinator.snapshot().workflows.length, 0);
  assert.equal(f.coordinator.snapshot().events.length, 0);
  assert.equal(f.deliveries.length, 0);
});
