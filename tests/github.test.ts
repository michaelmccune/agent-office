import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Claims, GitHub, MergeWatch, friendlyGhError } from '../src/server/github.js';
import type { GhIssue, GhPull, GhState } from '../src/shared/protocol.js';

const pull = (number: number, state: string): GhPull => ({
  number, title: `PR ${number}`, state, isDraft: false, url: '', author: '', labels: [], reviewDecision: '',
  headRefName: `b${number}`, baseRefName: 'main', createdAt: '', updatedAt: '', additions: 0, deletions: 0,
  checks: 'none', body: '', closes: [],
});
const numbers = (ps: GhPull[]) => ps.map((p) => p.number);

function forkCheckout(t: { after(fn: () => void): void }, fork = 'michaelmccune/agent-office', upstream = 'AgentSystemLabs/agent-office'): string {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-office-github-fork-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'checkout');
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', `https://github.com/${fork}.git`]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'upstream', `https://github.com/${upstream}.git`]);
  // gh repo fork / set-default can mark the parent as the checkout's base repository. In
  // non-interactive processes, that base wins over origin unless a command pins its repository.
  execFileSync('git', ['-C', dir, 'config', 'remote.upstream.gh-resolved', 'base']);
  return dir;
}

function defaultGhRepo(dir: string): string {
  const remotes = execFileSync('git', ['-C', dir, 'remote'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const base = remotes.find((remote) => {
    try {
      return execFileSync('git', ['-C', dir, 'config', '--get', `remote.${remote}.gh-resolved`], { encoding: 'utf8' }).trim() === 'base';
    } catch {
      return false;
    }
  });
  const remote = base ?? remotes[0];
  const url = execFileSync('git', ['-C', dir, 'remote', 'get-url', remote], { encoding: 'utf8' }).trim();
  const repo = /github\.com[:/]([^/]+\/[^/]+)$/.exec(url.replace(/\.git$/, ''))?.[1];
  assert.ok(repo, `expected a GitHub remote URL, got ${url}`);
  return repo;
}

interface GhCall {
  args: string[];
  repo: string;
  env?: Record<string, string>;
}

function selectedGhRepo(args: string[], cwd: string, env?: Record<string, string>): string {
  const explicit = args.indexOf('--repo');
  if (explicit !== -1) return args[explicit + 1];
  if (args[0] === 'repo' && args[1] === 'view' && args[2] && !args[2].startsWith('--')) return args[2];
  if (args[0] === 'api' && env?.GH_REPO) return env.GH_REPO;
  return defaultGhRepo(cwd);
}

function forkGhRunner(calls: GhCall[]) {
  const closed = new Set<string>();
  return async (args: string[], cwd: string, _timeout?: number, env?: Record<string, string>): Promise<string> => {
    const repo = selectedGhRepo(args, cwd, env);
    calls.push({ args, repo, env });
    if (args[0] === 'repo' && args[1] === 'view') {
      return JSON.stringify({ nameWithOwner: repo, squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: true });
    }
    if (args[0] === 'issue' && args[1] === 'list') {
      return args[args.indexOf('--state') + 1] === 'open'
        ? JSON.stringify(closed.has(`${repo}:issue:12`) ? [] : [{ number: repo === 'michaelmccune/agent-office' ? 12 : 92, title: `Issue from ${repo}`, state: 'OPEN', url: `https://github.com/${repo}/issues/${repo === 'michaelmccune/agent-office' ? 12 : 92}` }])
        : '[]';
    }
    if (args[0] === 'pr' && args[1] === 'list') {
      return args[args.indexOf('--state') + 1] === 'open'
        ? JSON.stringify(closed.has(`${repo}:pull:21`) ? [] : [{ number: repo === 'michaelmccune/agent-office' ? 21 : 91, title: `PR from ${repo}`, state: 'OPEN', url: `https://github.com/${repo}/pull/${repo === 'michaelmccune/agent-office' ? 21 : 91}` }])
        : '[]';
    }
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ number: 12, state: 'OPEN', body: `Issue from ${repo}`, comments: [] });
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ number: 21, state: 'OPEN', body: `PR from ${repo}`, comments: [], reviews: [], commits: [], statusCheckRollup: [] });
    if (args[0] === 'pr' && args[1] === 'diff') return `diff from ${repo}`;
    if (args[0] === 'issue' && args[1] === 'edit') return '';
    if (args[0] === 'pr' && args[1] === 'close') {
      closed.add(`${repo}:pull:${args[2]}`);
      return '';
    }
    if (args[0] === 'pr' && args[1] === 'merge') return '';
    if (args[0] === 'issue' && args[1] === 'close') {
      closed.add(`${repo}:issue:${args[2]}`);
      return '';
    }
    if (args[0] === 'api') {
      const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? '';
      if (endpoint.includes('/pulls/21/comments?')) return '';
      if (/\/issues\/\d+\/comments$/.test(endpoint)) return JSON.stringify({ id: 'comment-node', user: { login: 'ada' }, body: 'Looks good', created_at: '2026-01-01T00:00:00Z', html_url: `https://github.com/${repo}/issues/12#issuecomment-1` });
      if (endpoint.endsWith('/pulls/21/reviews')) return `https://github.com/${repo}/pull/21#pullrequestreview-1\n`;
      if (endpoint.endsWith('/labels?per_page=100')) return '{"name":"bug","color":"d73a4a"}\n';
      if (/\/issues\/\d+\/labels$/.test(endpoint)) return '[{"name":"bug","color":"d73a4a"}]';
    }
    throw new Error(`Unexpected fake gh command: ${args.join(' ')}`);
  };
}

test('a pull request that was open at the last look and is merged now rings once', () => {
  const w = new MergeWatch();
  assert.deepEqual(numbers(w.look([pull(1, 'OPEN'), pull(2, 'MERGED'), pull(3, 'OPEN')])), [], 'nothing rings on the first look');
  assert.deepEqual(numbers(w.look([pull(1, 'MERGED'), pull(2, 'MERGED'), pull(3, 'CLOSED')])), [1]);
  assert.deepEqual(numbers(w.look([pull(1, 'MERGED'), pull(2, 'MERGED')])), []);
});

test('a merge from the PR window rings right away, and not again when GitHub catches up', () => {
  const w = new MergeWatch();
  w.look([pull(5, 'OPEN'), pull(6, 'OPEN')]);
  assert.equal(w.ring(5), true);
  assert.equal(w.ring(5), false);
  // A look that started before the merge still says open; the next one says merged.
  assert.deepEqual(numbers(w.look([pull(5, 'OPEN'), pull(6, 'OPEN')])), []);
  assert.deepEqual(numbers(w.look([pull(5, 'MERGED'), pull(6, 'MERGED')])), [6]);
});

const issue = (number: number, assignees: string[] = []): GhIssue => ({
  number, title: `Issue ${number}`, state: 'OPEN', url: '', author: '', labels: [], assignees, createdAt: '', updatedAt: '', body: '', comments: 0,
});
const taken = (is: GhIssue[]) => is.filter((i) => i.taken).map((i) => i.number);

test('an issue a worker took is marked at once, before GitHub has answered', () => {
  const c = new Claims();
  c.take(7);
  assert.deepEqual(taken(c.mark([issue(6), issue(7)])), [7]);
  // A list that comes back while GitHub is still assigning it doesn't have its assignee yet.
  assert.deepEqual(taken(c.mark([issue(6), issue(7)], 1000)), [7]);
});

test('it stays marked over a list asked for before it was assigned, until one asked for after', () => {
  const c = new Claims();
  const answered = c.take(7);
  answered(true, 2000);
  assert.deepEqual(taken(c.mark([issue(7)], 1500)), [7], 'asked before GitHub had it assigned');
  assert.equal(c.has(7), true);
  const fresh = c.mark([issue(7, ['octocat'])], 2500);
  assert.deepEqual(taken(fresh), [], 'GitHub lists its assignee now, which is what keeps it In progress');
  assert.deepEqual(fresh[0].assignees, ['octocat']);
  assert.equal(c.has(7), false);
});

test("an issue GitHub wouldn't assign goes back to where it was", () => {
  const c = new Claims();
  const answered = c.take(7);
  const shown = c.mark([issue(7)]);
  assert.deepEqual(taken(shown), [7]);
  answered(false);
  const back = c.mark(shown);
  assert.deepEqual(taken(back), []);
  assert.equal('taken' in back[0], false);
});

test('handed over twice, the first answer failing leaves the second one standing', () => {
  const c = new Claims();
  const first = c.take(7);
  const second = c.take(7);
  first(false);
  assert.deepEqual(taken(c.mark([issue(7)])), [7]);
  second(true, 3000);
  assert.deepEqual(taken(c.mark([issue(7, ['octocat'])], 3500)), []);
});

test('gh JSON field errors keep the field that failed', () => {
  assert.equal(
    friendlyGhError('Unknown JSON field: "headRefOid"\nAvailable fields:\n  title\n  updatedAt\n  url'),
    'Unknown JSON field: "headRefOid"',
  );
});

test('pull request listing works when older gh versions reject optional fields', async () => {
  const unsupported = new Set(['url', 'headRefOid', 'updatedAt', 'statusCheckRollup', 'closingIssuesReferences']);
  const calls: string[] = [];
  const runner = async (args: string[]) => {
    if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'acme/app', squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: false });
    assert.deepEqual(args.slice(0, 2), ['pr', 'list']);
    const fields = String(args[args.indexOf('--json') + 1]).split(',');
    calls.push(fields.join(','));
    const bad = fields.find((f) => unsupported.has(f));
    if (bad) throw new Error(`Unknown JSON field: "${bad}"`);
    if (args[args.indexOf('--state') + 1] !== 'open') return '[]';
    return JSON.stringify([
      {
        number: 7,
        title: 'Fix login',
        state: 'OPEN',
        isDraft: false,
        author: { login: 'ada' },
        labels: [{ name: 'bug', color: 'd73a4a' }],
        reviewDecision: '',
        headRefName: 'fix-login',
        baseRefName: 'main',
        createdAt: '2026-01-01T00:00:00Z',
        additions: 4,
        deletions: 2,
        body: 'Closes #1',
      },
    ]);
  };
  let pulls: GhState<GhPull> | undefined;
  const github = new GitHub('/repo', 'acme/app', () => {}, (state) => (pulls = state), runner);

  await (github as unknown as { refreshPulls(): Promise<void> }).refreshPulls();

  assert.equal(pulls?.error, undefined);
  assert.equal(pulls?.items.length, 1);
  assert.equal(pulls?.items[0].url, 'https://github.com/acme/app/pull/7');
  assert.equal(pulls?.items[0].updatedAt, '2026-01-01T00:00:00Z');
  assert.equal(pulls?.items[0].checks, 'none');
  assert.ok(calls.some((fields) => !fields.includes('url') && !fields.includes('updatedAt')));
});

test('fork boards exclude upstream-only items and keep details and actions on the fork', async (t) => {
  const dir = forkCheckout(t);
  assert.equal(defaultGhRepo(dir), 'AgentSystemLabs/agent-office', 'gh resolves the upstream remote marked as base in a non-interactive checkout');

  const calls: GhCall[] = [];
  let issues: GhState<GhIssue> | undefined;
  let pulls: GhState<GhPull> | undefined;
  const github = new GitHub(dir, 'michaelmccune/agent-office', (state) => (issues = state), (state) => (pulls = state), forkGhRunner(calls));

  await github.refresh();

  assert.deepEqual(issues?.items.map((i) => i.number), [12], 'only the fork issue appears');
  assert.deepEqual(pulls?.items.map((p) => p.number), [21], 'only the fork PR appears');
  assert.ok(calls.filter(({ args }) => args[0] === 'issue' && args[1] === 'list').every((call) => call.repo === 'michaelmccune/agent-office'));
  assert.ok(calls.filter(({ args }) => args[0] === 'pr' && args[1] === 'list').every((call) => call.repo === 'michaelmccune/agent-office'));

  assert.match((await github.issueDetail(12)).body, /michaelmccune\/agent-office/);
  assert.match((await github.pullDetail(21)).body, /michaelmccune\/agent-office/);
  assert.match(await github.pullDiff(21), /michaelmccune\/agent-office/);
  assert.equal((await github.comment('issue', 12, 'Looks good', { key: 'user', env: { GITHUB_TOKEN: 'user-token' } })).comment?.body, 'Looks good');
  assert.equal((await github.comment('pull', 21, 'Looks good')).comment?.body, 'Looks good');
  assert.match(await github.review(21, '/tmp/review.md'), /michaelmccune\/agent-office/);
  assert.equal(await github.merge(21, 'squash', false, false), undefined);
  assert.equal(await github.close('pull', 21, { comment: 'Closing' }), undefined);
  assert.equal(await github.close('issue', 12, { reason: 'completed' }), undefined);
  assert.equal(await github.claim(12), undefined);
  assert.deepEqual((await github.setLabels('issue', 12, ['bug'], [], { key: 'user', env: { GITHUB_TOKEN: 'user-token' } })).labels?.map((l) => l.name), ['bug']);
  assert.deepEqual((await github.setLabels('pull', 21, ['bug'], [])).labels?.map((l) => l.name), ['bug']);
  assert.deepEqual((await github.repoLabels()).map((l) => l.name), ['bug']);

  const repositoryCalls = calls.filter(({ args }) => args[0] !== 'api' || args.some((arg) => arg.startsWith('repos/')));
  assert.ok(repositoryCalls.every((call) => call.repo === 'michaelmccune/agent-office'), 'all detail and mutation requests stay on the floor repository');
  for (const call of calls.filter(({ args }) => args[0] === 'api' && args.some((arg) => arg.startsWith('repos/')))) {
    assert.equal(call.env?.GH_REPO, 'michaelmccune/agent-office', `API placeholders are scoped for ${call.args[1]}`);
  }
  assert.ok(calls.some(({ args, env }) => args[0] === 'api' && args.some((arg) => arg.endsWith('/issues/12/comments')) && env?.GITHUB_TOKEN === 'user-token'), 'repository scoping preserves the account sign-in');
});

test("each floor's boards stay scoped to its own fork", async (t) => {
  const firstDir = forkCheckout(t, 'alice/agent-office', 'AgentSystemLabs/agent-office');
  const secondDir = forkCheckout(t, 'bob/agent-office', 'AgentSystemLabs/agent-office');
  const calls: GhCall[] = [];
  const runner = forkGhRunner(calls);
  const first = new GitHub(firstDir, 'alice/agent-office', () => {}, () => {}, runner);
  const second = new GitHub(secondDir, 'bob/agent-office', () => {}, () => {}, runner);

  await Promise.all([first.refresh(), second.refresh()]);

  assert.ok(calls.filter(({ args }) => args[0] === 'issue' && args[1] === 'list').some((call) => call.repo === 'alice/agent-office'));
  assert.ok(calls.filter(({ args }) => args[0] === 'pr' && args[1] === 'list').some((call) => call.repo === 'alice/agent-office'));
  assert.ok(calls.filter(({ args }) => args[0] === 'issue' && args[1] === 'list').some((call) => call.repo === 'bob/agent-office'));
  assert.ok(calls.filter(({ args }) => args[0] === 'pr' && args[1] === 'list').some((call) => call.repo === 'bob/agent-office'));
});
