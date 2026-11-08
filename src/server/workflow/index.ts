import type { Floor, FloorContext } from '../floor.js';
import { WorkflowCoordinator } from './coordinator.js';
import { workflowPorts, workflowWorktrees } from './adapters.js';
import { workflowQueuePolicies } from './queue-policies.js';

export function installWorkflows(floor: Floor, ctx: FloorContext, dataDir: string) {
  const ports = workflowPorts(floor, ctx);
  const coordinator = new WorkflowCoordinator(dataDir, floor.id, floor.def.repo ?? '', ports);
  const unregister = workflowWorktrees(floor, ctx, coordinator);
  const unqueue = workflowQueuePolicies(floor, ports, coordinator);
  coordinator.onShutdown = () => { unregister(); unqueue(); };
  void floor.ready.then(() => coordinator.start());
  return coordinator;
}
