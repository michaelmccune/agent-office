import type { StationKind } from '../../shared/layout.js';
import type { QueueTask, WorkerStatus } from '../../shared/protocol.js';

export type Role = StationKind | 'worker';
export type State = 'ready_for_planning' | 'queued' | 'implementing' | 'awaiting_review' | 'changes_requested' | 'awaiting_checks' | 'needs_human' | 'merged' | 'blocked' | 'failed' | 'cancelled';
export type EventType = 'issues.ready' | 'pr.ready' | 'review.fix' | 'workflow.report';
export interface Actor { id: string; role: Role; owner?: string }
export interface Verification { command: string; result: 'pass' | 'fail'; detail: string }
export interface Pull {
  number: number; url: string; head: string; branch: string; author: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED'; draft: boolean;
  checks: 'pass' | 'pending' | 'fail'; mergeable: boolean;
  requiredReviews: boolean; unresolved: boolean;
}
export interface Review {
  head: string;
  decision: 'changes_requested' | 'awaiting_checks' | 'needs_human' | 'eligible';
  summary: string;
  /** Reviewer must inspect all of these before declaring eligibility. */
  inspected: { diff: boolean; tests: boolean; instructions: boolean; findings: boolean; ci: boolean };
  securityReviewed: boolean;
  humanRequired: boolean;
}
export interface Workflow {
  id: string; issue: number; owner?: string; repository: string; floor: string;
  githubLogin: string;
  context: string; criteria: string[]; dependencies: number[];
  state: State; currentOwner: string; nextAction: string; blocker?: string; paused: boolean;
  plan?: { title: string; prompt: string };
  task?: string; worker?: string; branch?: string;
  pr?: number; head?: string; verification?: { head: string; results: Verification[] };
  review?: Review; round: number;
  reviewCycle: number;
  /** Only the originating signed-in human can grant these, never a peer message. */
  authority: { merge: boolean; approvedHead?: string; linkedPr?: number; securityHead?: string; grantedAt?: number; grantedBy?: string };
  mergeIntent?: string;
  lastPoll?: number; finishedTurnAt?: number;
  failures?: number; retryAt?: number;
  createdAt: number; updatedAt: number;
  timeline: { at: number; state: State; detail: string }[];
}
export interface Event {
  id: string; key: string; workflow: string; floor: string; repository: string; owner?: string;
  source: Role | 'coordinator' | 'github'; target: Role; type: EventType;
  issue: number; task?: string; worker?: string; pr?: number; head?: string;
  body: string; createdAt: number; updatedAt: number;
  state: 'pending' | 'leased' | 'acknowledged' | 'blocked' | 'cancelled';
  attempts: number; nextAt: number; leaseUntil?: number; recipient?: string; outcome?: string;
}
export interface Snapshot { version: 1; floor: string; repository: string; workflows: Workflow[]; events: Event[]; error?: string }
export interface Recipient { id: string; status: WorkerStatus; owner?: string }
export interface Ports {
  now(): number;
  identity(owner?: string): Promise<string>;
  /** Fail closed for revoked credentials or role permissions. */
  permitted(owner: string | undefined, role: Role): string | undefined;
  recipient(role: Role, worker?: string): Recipient | undefined;
  deliver(event: Event, prompt: string): string;
  tasks(): QueueTask[];
  ensureTask(workflow: Workflow, prompt: string): QueueTask;
  discover(workflow: Workflow): Promise<Pull | undefined>;
  pull(workflow: Workflow): Promise<Pull>;
  merge(workflow: Workflow, head: string): Promise<void>;
  workerActive?(id: string): boolean;
}
export const terminal = (w: Workflow) => ['merged', 'failed', 'cancelled'].includes(w.state);
