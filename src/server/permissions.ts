import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentPermissionsState, PermissionAction, PermissionChoices, PermissionRole } from '../shared/protocol.js';

export const DEFAULT_AGENT_PERMISSIONS: AgentPermissionsState['roles'] = {
  issues: { officeState: true, agentDiscussion: true, pushBranch: false },
  planning: { officeState: true, agentDiscussion: true, pushBranch: false },
  pulls: { officeState: true, agentDiscussion: true, pushBranch: false },
  worker: { officeState: true, agentDiscussion: false, pushBranch: true },
};

export const PERMISSION_ROLES: readonly PermissionRole[] = ['issues', 'planning', 'pulls', 'worker'];
export const PERMISSION_ACTIONS: readonly PermissionAction[] = ['officeState', 'agentDiscussion', 'pushBranch'];

export function isPermissionRole(value: unknown): value is PermissionRole {
  return typeof value === 'string' && (PERMISSION_ROLES as readonly string[]).includes(value);
}

export function isPermissionAction(value: unknown): value is PermissionAction {
  return typeof value === 'string' && (PERMISSION_ACTIONS as readonly string[]).includes(value);
}

export function roleForStation(station: 'issues' | 'pulls' | 'queue' | undefined): PermissionRole {
  return station === 'queue' ? 'planning' : station ?? 'worker';
}

/** Always-allow policy by built-in role, persisted for the whole office. */
export class OfficePermissions {
  private saved: AgentPermissionsState = { roles: structuredClone(DEFAULT_AGENT_PERMISSIONS) };
  private file: string;

  constructor(dataDir: string, private onState: (state: AgentPermissionsState) => void) {
    this.file = path.join(dataDir, 'permissions.json');
    this.restore();
  }

  state(): AgentPermissionsState {
    return { roles: structuredClone(this.saved.roles), ...(this.saved.by ? { by: this.saved.by, at: this.saved.at } : {}) };
  }

  allows(role: PermissionRole, action: PermissionAction): boolean {
    return this.saved.roles[role][action];
  }

  set(role: unknown, action: unknown, enabled: unknown, by: string): string | undefined {
    if (!isPermissionRole(role)) return 'Unknown agent role';
    if (!isPermissionAction(action)) return 'Unknown permission';
    if (typeof enabled !== 'boolean') return 'Permission must be on or off';
    if (this.saved.roles[role][action] === enabled) return;
    this.saved.roles[role][action] = enabled;
    this.saved.by = by;
    this.saved.at = Date.now();
    this.persist();
    this.onState(this.state());
  }

  private restore() {
    let raw: Partial<AgentPermissionsState>;
    try { raw = JSON.parse(readFileSync(this.file, 'utf8')); } catch { return; }
    for (const role of PERMISSION_ROLES) {
      for (const action of PERMISSION_ACTIONS) {
        const value = raw?.roles?.[role]?.[action];
        if (typeof value === 'boolean') this.saved.roles[role][action] = value;
      }
    }
    if (typeof raw?.by === 'string') this.saved.by = raw.by;
    if (typeof raw?.at === 'number') this.saved.at = raw.at;
  }

  private persist() {
    try { writeFileSync(this.file, JSON.stringify(this.saved, null, 2), { mode: 0o600 }); } catch { /* disk issues shouldn't take the office down */ }
  }
}
