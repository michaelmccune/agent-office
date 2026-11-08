import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkerPrs } from '../src/server/workers/pr.js';
import type { Worker, WorkerContext } from '../src/server/workers/types.js';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { Worktrees } from '../src/server/worktrees.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

test('a worker can publish only its assigned worktree branch, and receives Git failures', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-office-push-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '--quiet', '--initial-branch=main');
  git(root, 'config', 'user.name', 'Agent Office Test');
  git(root, 'config', 'user.email', 'agent-office@example.invalid');
  writeFileSync(path.join(root, 'base.txt'), 'base\n');
  git(root, 'add', 'base.txt');
  git(root, 'commit', '--quiet', '-m', 'Base');

  const remote = path.join(root, 'origin.git');
  git(root, 'init', '--quiet', '--bare', remote);
  git(root, 'remote', 'add', 'origin', remote);
  const worktree = path.join(root, '.agent-office', 'worktrees', 'byte');
  mkdirSync(path.dirname(worktree), { recursive: true });
  git(root, 'worktree', 'add', '--quiet', '-b', 'office/byte', worktree);
  const base = git(worktree, 'rev-parse', 'HEAD');

  const info = {
    id: 'worker-1',
    kind: 'agent',
    name: 'Byte',
    worktree: { path: path.relative(root, worktree), branch: 'office/byte', base },
  } as WorkerInfo;
  const worker = { info } as Worker;
  const trees = new Worktrees(root);
  const context = {
    dir: root,
    trees,
    workers: new Map([[info.id, worker]]),
    syncBranch: async () => {},
  } as unknown as WorkerContext;
  const prs = new WorkerPrs(context);

  writeFileSync(path.join(worktree, 'change.txt'), 'first reviewable change\n');
  git(worktree, 'add', 'change.txt');
  git(worktree, 'commit', '--quiet', '-m', 'Add reviewable change');
  assert.deepEqual(await prs.pushBranch(info.id), {
    pushed: [{ repo: path.basename(root), branch: 'office/byte' }],
    failed: [],
  });
  assert.ok(git(remote, 'show-ref', '--verify', 'refs/heads/office/byte'));
  assert.throws(() => git(remote, 'show-ref', '--verify', 'refs/heads/main'));

  git(worktree, 'remote', 'set-url', 'origin', path.join(root, 'missing-origin.git'));
  writeFileSync(path.join(worktree, 'follow-up.txt'), 'another change\n');
  git(worktree, 'add', 'follow-up.txt');
  git(worktree, 'commit', '--quiet', '-m', 'Add follow-up');
  const failed = await prs.pushBranch(info.id);
  assert.equal(typeof failed, 'object');
  if (typeof failed === 'string') return;
  assert.deepEqual(failed.pushed, []);
  assert.equal(failed.failed.length, 1);
  assert.equal(failed.failed[0].branch, 'office/byte');
  assert.match(failed.failed[0].error, /access rights|repository exists/);
});
