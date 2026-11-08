import type { AgentPermissionsState } from '../../../shared/protocol';
import type { Slice } from '../store';

declare module '../store' {
  interface Store { permissions: AgentPermissionsState }
  interface Topics { permissions: true }
}

export const permissions: Slice = {
  init(s) {
    s.permissions = { roles: {
      issues: { officeState: true, agentDiscussion: true, pushBranch: false },
      planning: { officeState: true, agentDiscussion: true, pushBranch: false },
      pulls: { officeState: true, agentDiscussion: true, pushBranch: false },
      worker: { officeState: true, agentDiscussion: false, pushBranch: true },
    } };
  },
  on: {
    welcome(s, m) { s.permissions = m.permissions; return ['permissions']; },
    permissions(s, m) { s.permissions = m.state; return ['permissions']; },
  },
};
