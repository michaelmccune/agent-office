import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Ctx } from '../src/server/office/context.js';
import { officeWorkflow } from '../src/server/workflow/hook.js';
import { WorkflowGitHub } from '../src/server/workflow/github.js';
import { workflowRoute } from '../src/server/workflow/routes.js';
import { main } from '../bin/office-workflow.js';
import { fixture, issueInput, NEXT, planned, review, reviewing, SHA } from './support/workflow.js';

test('CLI reaches the authenticated hook, binds roles/account from token and exposes timeline; worker tokens cannot grant merge authority', async (t) => {
  const f = fixture(t);
  f.manager.station('station-issues', 'human', 'authorized request');
  Object.defineProperty(f.floor, 'workflows', { get: () => f.coordinator });
  const ctx = { workerFloor: () => f.floor } as unknown as Ctx;
  const server = http.createServer((req, res) => void officeWorkflow(ctx, req, res, new URL(req.url!, 'http://localhost')));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env = { AGENT_OFFICE_HOOK_URL: base, AGENT_OFFICE_WORKER_ID: 'station-issues', AGENT_OFFICE_HOOK_TOKEN: 'token-station-issues' };
  const output: string[] = [], errors: string[] = [];
  assert.equal(await main(['ready', '--json', JSON.stringify(issueInput())], { env, out: (s) => output.push(s), err: (s) => errors.push(s) }), 0);
  assert.equal(errors.length, 0); assert.equal(f.state.authority.merge, false);
  assert.equal(await main(['list'], { env, out: (s) => output.push(s) }), 0);
  assert.match(output.at(-1)!, /issues.ready/);
  const unauthorized = await fetch(`${base}/office/workflow?worker=station-issues`, { headers: { authorization: 'Bearer bad-token' } });
  assert.equal(unauthorized.status, 401);
  const grant = await fetch(`${base}/office/workflow/authorize?worker=station-issues`, { method: 'POST', headers: { authorization: 'Bearer token-station-issues', 'content-type': 'application/json' }, body: JSON.stringify({ workflow: f.state.id, merge: true }) });
  assert.equal(grant.status, 409); assert.equal(f.state.authority.merge, false);
});

test('human session controls preserve originating account and refuse cross-origin authority requests', async (t) => {
  const f = fixture(t); await f.coordinator.ready(f.actor('issues', 'alice'), issueInput());
  Object.defineProperty(f.floor, 'workflows', { get: () => f.coordinator });
  const ctx = { floors: new Map([['floor-1', f.floor]]) } as unknown as Ctx;
  let owner = 'bob';
  const server = http.createServer((req, res) => void workflowRoute.handle(ctx, { req, res, url: new URL(req.url!, 'http://localhost'), path: '/api/workflows', session: { account: { id: owner } } } as never));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const options = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workflow: f.state.id, action: 'authorize', merge: true }) };
  assert.equal((await fetch(`${base}/api/workflows?floor=floor-1`, options)).status, 409);
  owner = 'alice';
  assert.equal((await fetch(`${base}/api/workflows?floor=floor-1`, { ...options, headers: { ...options.headers, origin: 'https://unrelated.example' } })).status, 403);
  assert.equal((await fetch(`${base}/api/workflows?floor=floor-1`, options)).status, 200);
  assert.equal(f.state.authority.merge, true);
});

test('pause/cancel gate already queued work; resume retains the same task and no browser is required', async (t) => {
  const f = fixture(t); f.queue.setLimit(0); await planned(f);
  const id = f.state.id, task = f.state.task;
  f.coordinator.control(undefined, id, 'pause'); f.queue.setLimit(1); f.queue.pump(); await f.coordinator.tick();
  assert.equal(f.workers.filter((w) => w.worktree).length, 0);
  f.coordinator.control(undefined, id, 'resume'); f.queue.pump(); await f.coordinator.tick();
  assert.equal(f.state.task, task); assert.equal(f.workers.filter((w) => w.worktree).length, 1);
  f.coordinator.control(undefined, id, 'cancel'); f.setPull(); f.advance(); await f.coordinator.tick();
  assert.equal(f.state.state, 'cancelled'); assert.equal(f.merges.length, 0);
});

test('a queued task whose worker spawned before a crash is adopted instead of spawning twice', async (t) => {
  const f = fixture(t); f.queue.setLimit(0); await planned(f);
  const task = f.queue.state().tasks[0];
  f.manager.spawn('desk-1', 'workflow', task.prompt, true, 'agent', 'codex');
  f.queue.setLimit(1); f.queue.pump(); await f.coordinator.tick();
  assert.equal(f.workers.filter((w) => w.worktree).length, 1);
  assert.equal(f.queue.state().tasks[0].workerId, 'impl-0');
});

test('fresh GitHub boundary pins repository/account/SHA and never merges protected, draft, unresolved or failed-check PRs', async (t) => {
  const f = fixture(t); const event = await reviewing(f); f.coordinator.review(f.actor('pulls'), event.id, review());
  f.coordinator.control(undefined, f.state.id, 'authorize', { merge: true });
  let head = SHA, login = 'originator', clean = true, unresolved = false, checks: any[] = [], draft = false, wrongRepo = false;
  const calls: string[][] = [], environments: (Record<string, string> | undefined)[] = [];
  const run = async (args: string[], _dir: string, _timeout?: number, env?: Record<string, string>) => {
    calls.push(args); environments.push(env);
    if (args[0] === 'api' && args[1] === 'user') return login;
    if (args[0] === 'pr') return JSON.stringify({ number: 30, url: `https://github.com/${wrongRepo ? 'wrong/repo' : 'michaelmccune/agent-office'}/pull/30`, headRefOid: head, headRefName: f.state.branch, author: { login: 'webdevcody' }, state: 'OPEN', isDraft: draft, reviewDecision: '', mergeable: 'MERGEABLE', mergeStateStatus: clean ? 'CLEAN' : 'BLOCKED', statusCheckRollup: checks });
    if (args[1] === 'graphql') return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{ isResolved: !unresolved }] } } } } });
    return JSON.stringify({ merged: true });
  };
  const env = { GH_CONFIG_DIR: '/account/alice/gh', GH_REPO: 'wrong/repo' };
  const github = new WorkflowGitHub(f.dir, 'michaelmccune/agent-office', () => ({ key: 'alice', env }), run);
  await github.merge(f.state, SHA);
  const write = calls.find((c) => c.includes('PUT'))!;
  assert.ok(write.includes('repos/michaelmccune/agent-office/pulls/30/merge'));
  assert.ok(write.includes('merge_method=squash')); assert.ok(write.includes(`sha=${SHA}`));
  assert.ok(calls.filter((c) => c[0] === 'pr').every((c) => c.includes('--repo') && c.includes('michaelmccune/agent-office')));
  assert.ok(environments.every((e) => e === env));
  calls.length = 0;
  head = NEXT; await assert.rejects(github.merge(f.state, SHA), /changed after review/); head = SHA;
  clean = false; await assert.rejects(github.merge(f.state, SHA), /reviews|protection|mergeability/); clean = true;
  unresolved = true; await assert.rejects(github.merge(f.state, SHA), /unresolved/); unresolved = false;
  checks = [{ status: 'COMPLETED', conclusion: 'FAILURE' }]; await assert.rejects(github.merge(f.state, SHA), /Checks failed/); checks = [];
  draft = true; await assert.rejects(github.merge(f.state, SHA), /non-draft/); draft = false;
  wrongRepo = true; await assert.rejects(github.merge(f.state, SHA), /identity/); wrongRepo = false;
  login = 'other-person'; await assert.rejects(github.merge(f.state, SHA), /login changed/);
  assert.equal(calls.filter((c) => c.includes('PUT')).length, 0);
});

test('authorization revoked while GitHub preflight is in flight prevents the merge write', async (t) => {
  const f = fixture(t); const event = await reviewing(f); f.coordinator.review(f.actor('pulls'), event.id, review());
  f.coordinator.control(undefined, f.state.id, 'authorize', { merge: true });
  let writes = 0;
  const run = async (args: string[]) => {
    if (args[1] === 'user') return 'originator';
    if (args[0] === 'pr') return JSON.stringify({ number: 30, url: 'https://github.com/michaelmccune/agent-office/pull/30', headRefOid: SHA, headRefName: f.state.branch, author: { login: 'webdevcody' }, state: 'OPEN', isDraft: false, reviewDecision: '', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [] });
    if (args[1] === 'graphql') { f.coordinator.control(undefined, f.state.id, 'authorize', { merge: false }); return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } }); }
    writes++; return '{"merged":true}';
  };
  const github = new WorkflowGitHub(f.dir, 'michaelmccune/agent-office', () => undefined, run, () => f.state);
  await assert.rejects(github.merge(f.state, SHA), /merge authority/);
  assert.equal(writes, 0);
});
