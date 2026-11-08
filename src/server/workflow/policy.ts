import type { Pull, Workflow } from './types.js';

/** Conservative repository policy floor. No message, issue body, or reviewer can grant merge power.
 * The same guards are checked again on a fresh GitHub snapshot immediately before the API write. */
export function mergeBlocker(w: Workflow, p: Pull): string | undefined {
  if (!w.authority.merge) return 'Human decision: grant merge authority for this workflow, or merge manually';
  if (w.review?.decision !== 'eligible' || w.review.head !== p.head) return 'Current head has not been reviewed as eligible';
  if (w.review.humanRequired && w.authority.approvedHead !== p.head) return `Human approval required for reviewed head ${p.head}`;
  if (p.author !== 'webdevcody' && (w.authority.linkedPr !== p.number || w.authority.securityHead !== p.head || !w.review.securityReviewed)) return `Author ${p.author} requires explicit human PR linking and security review of head ${p.head}`;
  if (p.state !== 'OPEN' || p.draft) return 'PR must be open and non-draft';
  if (p.checks !== 'pass') return p.checks === 'fail' ? 'Checks failed: fix failures and re-review' : 'Waiting for required checks';
  if (!p.requiredReviews || p.unresolved) return 'Resolve required reviews and unresolved findings before merge';
  if (!p.mergeable) return 'Branch protection/mergeability is unresolved; resolve conflicts preserving both sides';
  return undefined;
}
