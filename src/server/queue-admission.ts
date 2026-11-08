import type { QueueTask, WorkerInfo } from '../shared/protocol.js';

type Guard = (task: QueueTask) => boolean;
const guards = new Set<Guard>();
const recoveries = new Set<(task: QueueTask) => WorkerInfo | undefined>();
/** Feature admission policies only hold tasks; the queue retains all scheduling/resource limits. */
export function registerQueueAdmission(guard: Guard) { guards.add(guard); return () => { guards.delete(guard); }; }
export function queueAdmitted(task: QueueTask) { return [...guards].every((guard) => guard(task)); }
export function registerQueueRecovery(recover: (task: QueueTask) => WorkerInfo | undefined) { recoveries.add(recover); return () => { recoveries.delete(recover); }; }
export function recoverQueuedTask(task: QueueTask): Partial<QueueTask> | undefined {
  const worker = [...recoveries].map((f) => f(task)).find(Boolean);
  return worker ? { status: 'running', workerId: worker.id, workerName: worker.name, branch: worker.worktree?.branch, startedAt: worker.createdAt } : undefined;
}
