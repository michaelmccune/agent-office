import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { TestContext } from 'node:test';
import { TaskQueue, type QueueWorkers } from '../../src/server/queue.js';
import type { WorkerInfo } from '../../src/shared/protocol.js';
import type { Floor, FloorContext } from '../../src/server/floor.js';
import { WorkflowCoordinator } from '../../src/server/workflow/coordinator.js';
import { workflowPorts } from '../../src/server/workflow/adapters.js';
import { OfficePermissions } from '../../src/server/permissions.js';
import { workflowQueuePolicies } from '../../src/server/workflow/queue-policies.js';
import type { Actor, EventType, Pull, Review, Role } from '../../src/server/workflow/types.js';

export const SHA = 'a'.repeat(40), NEXT = 'b'.repeat(40);
export const inspected = { diff: true, tests: true, instructions: true, findings: true, ci: true };
export const review = (decision: Review['decision'] = 'eligible', head = SHA): Review => ({ head, decision, summary: 'Reviewed current diff, CI and instructions', inspected, securityReviewed: false, humanRequired: false });
export const issueInput = (issue = 12) => ({ issues: [issue], criteria: ['Pass the acceptance scenario'], dependencies: [] as number[], context: 'Implement this request autonomously', authorized: true });

export function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-workflow-'));
  const workers: WorkerInfo[] = [];
  const owners = new Map<string, string | undefined>();
  const deliveries: { target: string; prompt: string }[] = [];
  const permissions = new OfficePermissions(dir, () => {});
  const makeWorker = (id: string, deskId: string, prompt?: string, owner?: string, worktree = false) => {
    const w: WorkerInfo = { id, deskId, kind: 'agent', provider: 'codex', prompt, name: id, status: 'working', color: '#fff', acked: false, createdAt: 1, createdBy: 'workflow', cols: 80, rows: 24, viewers: [], viewerIds: [],
      worktree: worktree ? { branch: `office/${id}`, path: `.agent-office/worktrees/${id}`, base: '0'.repeat(40) } : undefined };
    workers.push(w); owners.set(id, owner); return w;
  };
  const manager = {
    defaultProvider: 'codex' as const,
    list: () => workers,
    get: (id: string) => workers.find((w) => w.id === id),
    ownerOf: (id: string) => owners.get(id),
    authenticate: (id: string, token: string) => token === `token-${id}` ? workers.find((w) => w.id === id) : undefined,
    deskOccupied: (desk: string) => workers.some((w) => w.deskId === desk),
    spawn(desk: string, _by: string, prompt: string, wt: boolean, _kind: string, _provider: string, _model?: string, _effort?: string, _meeting?: undefined, owner?: string) { return makeWorker(`impl-${workers.filter((w) => w.worktree).length}`, desk, prompt, owner, wt); },
    async kill(id: string) { const i = workers.findIndex((w) => w.id === id); if (i >= 0) workers.splice(i, 1); return {}; },
    station(desk: string, _by: string, prompt: string, owner?: string) {
      let w = workers.find((w) => w.deskId === desk);
      if (!w) w = makeWorker(desk, desk, prompt, owner);
      w.status = 'working'; deliveries.push({ target: desk, prompt });
      return { info: w, hired: false };
    },
    prompt(id: string, prompt: string) { const w = workers.find((w) => w.id === id); if (!w) return 'No such worker'; w.status = 'working'; deliveries.push({ target: id, prompt }); },
    resume(id: string, prompt: string) { return manager.prompt(id, prompt); },
  };
  let q = new TaskQueue(dir, manager as QueueWorkers, true, { update() {}, toast() {}, claimIssue: async () => undefined, refreshGitHub() {}, hiringPaused: () => undefined, emptied() {} });
  const ctx = { ghAs: () => undefined, permissions, accountActive: () => true } as unknown as FloorContext;
  const floor = { dir, id: 'floor-1', project: { branch: 'main' }, def: { repo: 'michaelmccune/agent-office' }, workers: manager, get queue() { return q; } } as unknown as Floor;
  const ports = workflowPorts(floor, ctx);
  let now = 1_000_000;
  let pull: Pull | undefined;
  const merges: string[] = [];
  ports.now = () => now;
  ports.identity = async () => 'originator';
  ports.discover = async () => pull && structuredClone(pull);
  ports.pull = async () => { if (!pull) throw new Error('PR unavailable'); return structuredClone(pull); };
  ports.merge = async (_w, head) => { merges.push(head); pull = { ...pull!, state: 'MERGED' }; };
  let c = new WorkflowCoordinator(dir, floor.id, floor.def.repo!, ports);
  c.onShutdown = workflowQueuePolicies(floor, ports, c);
  const actor = (role: Role, owner?: string): Actor => {
    const id = role === 'worker' ? c.snapshot().workflows[0]?.worker ?? 'impl-0' : `station-${role}`;
    return { id, role, owner };
  };
  const event = (type: EventType) => c.snapshot().events.filter((e) => e.type === type && e.state === 'leased').at(-1)!;
  const advance = (ms = 16_000) => { now += ms; };
  const markDone = (id: string) => { const w = manager.get(id)!; w.status = 'done'; q.onWorker(w); };
  const setPull = (override: Partial<Pull> = {}) => {
    pull = { number: 30, url: 'https://github.com/michaelmccune/agent-office/pull/30', branch: c.snapshot().workflows[0]?.branch ?? 'office/impl-0', head: SHA, author: 'webdevcody', state: 'OPEN', draft: false, checks: 'pass', mergeable: true, requiredReviews: true, unresolved: false, ...override };
  };
  const restart = () => { c.shutdown(); q.shutdown(); q = new TaskQueue(dir, manager as QueueWorkers, true, { update() {}, toast() {}, claimIssue: async () => undefined, refreshGitHub() {}, hiringPaused: () => undefined, emptied() {} }); c = new WorkflowCoordinator(dir, floor.id, floor.def.repo!, ports); c.onShutdown = workflowQueuePolicies(floor, ports, c); };
  t.after(() => { c.shutdown(); q.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, workers, owners, manager, ports, floor, ctx, permissions, deliveries, merges, actor, event, advance, markDone, setPull, restart,
    get coordinator() { return c; }, get queue() { return q; }, get state() { return c.snapshot().workflows[0]; }, get pull() { return pull; } };
}

export async function planned(f: ReturnType<typeof fixture>, issue = 12) {
  await f.coordinator.ready(f.actor('issues'), issueInput(issue));
  await f.coordinator.tick();
  f.coordinator.plan(f.actor('queue'), f.event('issues.ready').id, { title: 'Implement issue', prompt: 'Implement the acceptance criteria and verify the result' });
  f.markDone('station-queue');
  await f.coordinator.tick();
}

export async function reviewing(f: ReturnType<typeof fixture>) {
  await planned(f);
  f.setPull(); f.markDone(f.state.worker!); f.advance();
  await f.coordinator.tick();
  return f.event('pr.ready');
}
