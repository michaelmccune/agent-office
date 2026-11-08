import { gh } from '../github.js';
import type { GhAs } from '../signins.js';
import type { Pull, Workflow } from './types.js';
import { mergeBlocker } from './policy.js';

type Runner = typeof gh;
/** Every request is pinned to the floor repository AND original account. No checkout-default repo,
 * credentials fallback, auto-merge, admin override, or branch deletion in the shared checkout. */
export class WorkflowGitHub {
  constructor(private dir: string, private repo: string, private as: (owner?: string) => GhAs | undefined | string, private run: Runner = gh, private beforeMerge: (w: Workflow) => Workflow = (w) => w) {}
  private env(owner?: string) {
    const as = this.as(owner);
    if (typeof as === 'string') throw new Error(as);
    return as?.env;
  }
  async identity(owner?: string) {
    const login = (await this.run(['api', 'user', '--jq', '.login'], this.dir, undefined, this.env(owner))).trim();
    if (!login) throw new Error('GitHub account identity unavailable');
    return login;
  }
  private async checked(w: Workflow) {
    if (w.repository !== this.repo) throw new Error('Repository boundary mismatch');
    if (await this.identity(w.owner) !== w.githubLogin) throw new Error('GitHub login changed since authorization; restore originating credentials');
    return this.env(w.owner);
  }
  async discover(w: Workflow): Promise<Pull | undefined> {
    if (!w.branch) return undefined;
    const env = await this.checked(w);
    const out = await this.run(['pr', 'list', '--repo', this.repo, '--head', w.branch, '--state', 'all', '--limit', '100', '--json', 'number'], this.dir, undefined, env);
    const list = JSON.parse(out) as { number: number }[];
    if (list.length > 1) throw new Error('Multiple PRs on the implementation branch; explicitly link the correct one');
    return list[0] ? this.pull({ ...w, pr: list[0].number }) : undefined;
  }
  async pull(w: Workflow): Promise<Pull> {
    if (!w.pr) throw new Error('No linked PR');
    const env = await this.checked(w);
    const out = await this.run(['pr', 'view', String(w.pr), '--repo', this.repo, '--json', 'number,url,headRefOid,headRefName,author,state,isDraft,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup'], this.dir, undefined, env);
    const p = JSON.parse(out);
    if (p.number !== w.pr || typeof p.url !== 'string' || p.url.toLowerCase() !== `https://github.com/${this.repo}/pull/${w.pr}`.toLowerCase() || !/^[a-f\d]{40,64}$/i.test(p.headRefOid)) throw new Error('GitHub PR identity/head unavailable');
    const [owner, repo] = this.repo.split('/');
    const query = 'query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){pageInfo{hasNextPage}nodes{isResolved}}}}}';
    const raw = await this.run(['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `repo=${repo}`, '-F', `number=${w.pr}`], this.dir, undefined, env);
    const answer = JSON.parse(raw);
    const threads = answer.data?.repository?.pullRequest?.reviewThreads;
    if (answer.errors || !threads) throw new Error('Cannot verify unresolved PR findings');
    const checks = p.statusCheckRollup;
    if (!Array.isArray(checks)) throw new Error('Cannot verify PR checks');
    const failed = checks.some((c: any) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'].includes(c.conclusion ?? c.state));
    const pending = checks.some((c: any) => (c.status && c.status !== 'COMPLETED') || !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion ?? c.state));
    return {
      number: p.number, url: p.url, head: p.headRefOid, branch: p.headRefName, author: p.author?.login ?? '',
      state: p.state, draft: p.isDraft !== false,
      checks: failed ? 'fail' : pending ? 'pending' : 'pass',
      mergeable: p.mergeable === 'MERGEABLE' && p.mergeStateStatus === 'CLEAN',
      requiredReviews: ['APPROVED', ''].includes(p.reviewDecision ?? '') && p.mergeStateStatus === 'CLEAN',
      unresolved: threads.pageInfo?.hasNextPage !== false || threads.nodes.some((t: any) => t.isResolved !== true),
    };
  }
  async merge(w: Workflow, head: string) {
    const fresh = await this.pull(w);
    if (fresh.head !== head) throw new Error('PR changed after review; current head must be re-reviewed');
    const blocked = mergeBlocker(w, fresh);
    if (blocked) throw new Error(blocked);
    const env = await this.checked(w);
    const live = this.beforeMerge(w);
    if (live.paused || live.state === 'cancelled') throw new Error('Workflow paused or cancelled before merge');
    const currentBlocker = mergeBlocker(live, fresh);
    if (currentBlocker) throw new Error(currentBlocker);
    const result = JSON.parse(await this.run(['api', '--method', 'PUT', `repos/${this.repo}/pulls/${fresh.number}/merge`, '-f', 'merge_method=squash', '-f', `sha=${head}`], this.dir, 90_000, env));
    if (result.merged !== true) throw new Error(result.message ?? 'GitHub did not confirm squash merge');
  }
}
