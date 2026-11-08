// What the board agents are told when they're hired: the agents standing by the Issues board, the PR
// board and the task queue (STATIONS in shared/layout.ts). Whoever walks up types them a request; the
// first one follows this brief in the same prompt. The briefs themselves are prompts the office can
// rewrite in ⚙️ Settings (shared/prompts.ts).

import type { StationKind } from '../shared/layout.js';
import { floorRepository, floorRepositoryContext } from './github-context.js';
import { officePrompt, type PromptSource } from './prompts.js';

/** The board agent's floor context, plus reviewer eligibility rules for the PR board. */
export function stationScope(kind: StationKind, repo?: string): string {
  const target = floorRepository(repo);
  const context = floorRepositoryContext(target);
  if (kind !== 'pulls') return context;
  if (!target) return context;
  return [
    context,
    `Use ${target} as the default target for PR board actions; use another repository only when the person explicitly names it.`,
    `For example, list open PRs with \`gh pr list --repo ${target} --state open\`; read with \`gh pr view <number> --repo ${target}\`; pass that same option to diff, checks, comments, reviews, edits, merges and closes.`,
    `Before changing review requests, inspect them with \`gh pr view <number> --repo ${target} --json reviewRequests\` and verify requested users' access with \`gh api repos/${target}/collaborators/<login>/permission\` (and requested teams with \`gh api repos/${target}/teams --paginate\`). Check eligibility on the exact repository containing the PR; for an explicitly requested cross-repository PR, replace ${target} with that exact owner/name in every command. Request only reviewers confirmed eligible there. If none are eligible, explain that and do not attempt the request or act on another repository.`,
  ].join('\n');
}

export function stationBrief(kind: StationKind, prompts?: PromptSource, repo?: string): string {
  const brief = officePrompt(prompts, `station.${kind}`);
  const scope = stationScope(kind, repo);
  const request = 'The request:';
  const at = brief.lastIndexOf(request);
  return at >= 0 && !brief.slice(at + request.length).trim()
    ? `${brief.slice(0, at).trimEnd()}\n\n${scope}\n\n${request}`
    : `${brief}\n\n${scope}`;
}

/** A follow-up board request, for a session that may have been hired before its repo context existed. */
export function stationRequest(kind: StationKind, repo: string | undefined, request: string): string {
  return `${stationScope(kind, repo)}\n\nThe request: ${request}`;
}

/** Claude Code tools the queue agent is launched without, so it can't edit the checkout even by mistake. */
export const QUEUE_AGENT_DISALLOWED_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
