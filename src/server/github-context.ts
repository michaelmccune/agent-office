import { normalizeRepo } from '../shared/floors.js';

/** GH_REPO must not fall back to a user's inherited/upstream default when a floor has no identity. */
export const MISSING_FLOOR_REPOSITORY = '_agent_office_missing_floor_repository_';

/** The configured GitHub repository for a floor, normalized before it reaches a process or a prompt. */
export function floorRepository(repo?: string): string | undefined {
  return normalizeRepo(repo);
}

/** Sets the per-process gh default without changing authentication or any server-wide environment. */
export function setFloorRepositoryEnv(env: Record<string, string>, repo?: string): Record<string, string> {
  env.GH_REPO = floorRepository(repo) ?? MISSING_FLOOR_REPOSITORY;
  return env;
}

/** Builds a child gh environment from the office or an account sign-in, pinned to one floor. */
export function floorGhEnv(repo?: string, inherited?: Record<string, string>): Record<string, string> {
  const source = inherited ?? process.env;
  const env = Object.fromEntries(Object.entries(source).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  return setFloorRepositoryEnv(env, repo);
}

/** Context shared by generated agent prompts; explicit repository targets still take precedence. */
export function floorRepositoryContext(repo?: string): string {
  const target = floorRepository(repo);
  if (!target) {
    return "The active floor's GitHub repository identity is unavailable. Do not run floor-scoped GitHub commands or use gh's checkout/upstream/inherited default; ask the person to clarify. For an explicitly requested cross-repository task, use only the exact owner/repo they name.";
  }
  return `The active floor's selected GitHub repository is \`${target}\`. \`GH_REPO\` defaults to this repository. Include \`--repo ${target}\` on GitHub CLI commands that support it, and use fully qualified \`repos/${target}/...\` paths for \`gh api\`. These defaults are not a restriction: for an explicitly requested cross-repository task, use its exact owner/repo with \`--repo\` or a fully qualified API path. Never infer a target from gh's checkout default, local remotes, or an inherited \`GH_REPO\`.`;
}

/** How a meeting tells its reviewers to read a selected floor issue or PR. */
export function floorItemReadContext(kind: 'issue' | 'pull', number: number, repo?: string): string {
  const target = floorRepository(repo);
  if (!target) return `GitHub ${kind} #${number} was selected, but this floor's repository identity is unavailable. Ask for clarification before running GitHub commands.`;
  return kind === 'pull'
    ? `The pull request is #${number} in ${target}: read it with gh pr view ${number} --repo ${target} and gh pr diff ${number} --repo ${target}.`
    : `It comes from GitHub issue #${number} in ${target}: gh issue view ${number} --comments --repo ${target}.`;
}

/** Adds repository context to fresh and resumed conversations without repeating an existing copy. */
export function withFloorRepositoryContext(prompt: string | undefined, context: string): string {
  if (!prompt) return context;
  return prompt.includes(context) ? prompt : `${context}\n\n${prompt}`;
}
