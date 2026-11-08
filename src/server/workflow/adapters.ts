import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Floor, FloorContext } from '../floor.js';
import type { Ports, Workflow } from './types.js';
import { roleForStation } from '../permissions.js';
import { WorkflowGitHub } from './github.js';
import { registerWorktreeFactory } from '../workers/worktree-factories.js';
import type { WorkflowCoordinator } from './coordinator.js';

export function workflowPorts(floor: Floor, ctx: FloorContext): Ports {
  const github = new WorkflowGitHub(floor.dir, floor.def.repo ?? '', ctx.ghAs, undefined, (saved) => {
    const w = floor.workflows.snapshot().workflows.find((x) => x.id === saved.id);
    if (!w || !ctx.permissions.allows('pulls', 'agentDiscussion') || w.owner && ctx.accountActive?.(w.owner) === false) throw new Error('Workflow or review authority revoked before merge');
    return w;
  });
  return {
    now: Date.now,
    identity: (owner) => github.identity(owner),
    permitted(owner, role) {
      if (owner && ctx.accountActive?.(owner) === false) return 'Originating account was revoked';
      const permission = role === 'worker' ? 'officeState' : 'agentDiscussion';
      if (!ctx.permissions.allows(roleForStation(role === 'worker' ? undefined : role), permission)) return `Role ${role} automatic workflow delivery is disabled in role permissions (${permission})`;
      const as = ctx.ghAs(owner);
      return typeof as === 'string' ? as : undefined;
    },
    recipient(role, id) {
      const w = floor.workers.list().find((w) => role === 'worker' ? w.id === id : w.deskId === `station-${role}`);
      return w && { id: w.id, status: w.status, owner: floor.workers.ownerOf(w.id) };
    },
    deliver(e, prompt) {
      if (e.target !== 'worker') {
        const result = floor.workers.station(`station-${e.target}`, 'durable workflow', prompt, e.owner);
        if (typeof result === 'string') throw new Error(result);
        return result.info.id;
      }
      const w = floor.workers.get(e.worker ?? '');
      if (!w) throw new Error('Implementation worker unavailable; human must link a replacement task');
      const active = floor.workers.list().filter((x) => !x.deskId.startsWith('station-') && ['starting', 'working', 'needs_input'].includes(x.status)).length;
      if (active >= floor.queue.limit) throw new Error('Review fix waits for an implementation slot under the queue limit');
      if (floor.workers.ownerOf(w.id) !== e.owner || w.kind !== 'agent') throw new Error('Implementation worker account/type mismatch');
      let error = floor.workers.prompt(w.id, prompt, 'durable review findings');
      if (error === 'Worker is not running') error = floor.workers.resume(w.id, prompt);
      if (error) throw new Error(error);
      return w.id;
    },
    tasks: () => floor.queue.state().tasks,
    workerActive: (id) => { const status = floor.workers.get(id)?.status; return !!status && ['starting', 'working', 'needs_input'].includes(status); },
    ensureTask(w, prompt) {
      if (!floor.project.branch) throw new Error('Workflow implementation requires a git checkout and an isolated worktree');
      const marker = `<!-- office-workflow:${w.id} -->`;
      const found = floor.queue.state().tasks.find((t) => t.prompt.includes(marker));
      if (found) {
        if (found.owner !== w.owner || found.issue !== w.issue) throw new Error('Queue marker identity mismatch');
        return found;
      }
      // This calls the existing capacity/budget/desk/fetch-aware queue, not a second scheduler.
      const error = floor.queue.add(prompt, 'durable Queue/Planning', w.plan!.title, w.issue, undefined, undefined, undefined, w.owner);
      if (error) throw new Error(error);
      const task = floor.queue.state().tasks.find((t) => t.prompt.includes(marker));
      if (!task) throw new Error('Queue did not persist the linked task');
      return task;
    },
    discover: (w) => github.discover(w),
    pull: (w) => github.pull(w),
    merge: (w, sha) => github.merge(w, sha),
  };
}

/** Strict workflow-only worktree policy. Ordinary/manual hires retain their existing behavior. */
export function workflowWorktrees(floor: Floor, ctx: FloorContext, coordinator: WorkflowCoordinator) {
  return registerWorktreeFactory(floor.dir, (slug, prompt) => {
    const id = /<!-- office-workflow:([\w-]+) -->/.exec(prompt)?.[1];
    if (!id) return undefined;
    const w = coordinator.snapshot().workflows.find((x) => x.id === id);
    if (!w || w.paused || w.state === 'cancelled') return 'Workflow is unavailable, paused or cancelled';
    return strictWorktree(floor.dir, slug, w, ctx.ghAs);
  });
}

export function strictWorktree(dir: string, slug: string, w: Workflow, ghAs: FloorContext['ghAs'], exec: typeof execFileSync = execFileSync) {
  const as = ghAs(w.owner);
  if (typeof as === 'string') return as;
  const env = { ...(as?.env ?? process.env), GIT_TERMINAL_PROMPT: '0' };
  const git = (args: string[]) => String(exec('git', args, { cwd: dir, env, timeout: 30_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
  try {
    const login = String(exec('gh', ['api', 'user', '--jq', '.login'], { cwd: dir, env, timeout: 15_000, encoding: 'utf8' })).trim();
    if (login !== w.githubLogin) return 'GitHub login changed since workflow authorization';
    const origin = git(['config', '--get', 'remote.origin.url']);
    const target = /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^\s]+?)(?:\.git)?$/.exec(origin)?.[1];
    if (target?.toLowerCase() !== w.repository.toLowerCase()) return 'origin no longer matches the authorized workflow repository';
    // Fetch must succeed; never fall back to local HEAD or unpushed main commits.
    git(['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
    const base = git(['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}']);
    const rel = path.join('.agent-office', 'worktrees', slug), branch = `office/${slug}`;
    git(['worktree', 'add', '-b', branch, path.resolve(dir, rel), base]);
    return { path: rel, branch, base, from: 'main' };
  } catch (error) { return `Workflow requires a fresh origin/main worktree: ${(error as Error).message}`; }
}
