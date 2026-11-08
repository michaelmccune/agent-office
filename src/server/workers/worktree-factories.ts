import type { WorkerInfo } from '../../shared/protocol.js';
import type { Worktrees } from '../worktrees.js';

type Factory = (slug: string, prompt: string) => (NonNullable<WorkerInfo['worktree']> & { note?: string }) | string | undefined;
const factories = new Map<string, Factory>();
/** Scoped extension point for features that require a stricter worktree start policy. */
export function registerWorktreeFactory(dir: string, factory: Factory) {
  factories.set(dir, factory);
  return () => { if (factories.get(dir) === factory) factories.delete(dir); };
}
export function createWorkerWorktree(trees: Worktrees, dir: string, slug: string, prompt = '') {
  return factories.get(dir)?.(slug, prompt) ?? trees.create(slug);
}
