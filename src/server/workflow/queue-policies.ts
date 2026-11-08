import type { Floor } from '../floor.js';
import { registerQueueAdmission, registerQueueRecovery } from '../queue-admission.js';
import type { WorkflowCoordinator } from './coordinator.js';
import type { Ports } from './types.js';

/** Gates apply at seating time too: a task already persisted before pause/revocation must wait. */
export function workflowQueuePolicies(floor: Floor, ports: Ports, coordinator: WorkflowCoordinator) {
  const unguard = registerQueueAdmission((task) => {
    const id = /<!-- office-workflow:([\w-]+) -->/.exec(task.prompt)?.[1];
    if (!id) return true;
    const w = coordinator.snapshot().workflows.find((x) => x.id === id);
    return !w || (!w.paused && !['cancelled', 'failed', 'merged'].includes(w.state) && !ports.permitted(w.owner, 'queue'));
  });
  const unrecover = registerQueueRecovery((task) => {
    const id = /<!-- office-workflow:([\w-]+) -->/.exec(task.prompt)?.[1];
    if (!id || !coordinator.snapshot().workflows.some((w) => w.id === id)) return;
    return floor.workers.list().find((w) => w.prompt?.includes(`<!-- office-workflow:${id} -->`) && floor.workers.ownerOf(w.id) === task.owner);
  });
  return () => { unguard(); unrecover(); };
}
