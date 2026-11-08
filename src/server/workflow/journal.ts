import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Snapshot } from './types.js';
import { writeDurableJson } from '../durable-json.js';

/** One atomic transaction contains both inbox outcome and new outbox entries. No swallowed disk
 * errors: a producer must not acknowledge success or dispatch an unpersisted action. */
export class Journal {
  private file: string;
  data: Snapshot;
  constructor(dir: string, floor: string, repository: string) {
    this.file = path.join(dir, 'workflows.json');
    this.data = { version: 1, floor, repository, workflows: [], events: [] };
    if (existsSync(this.file)) {
      try {
        const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Snapshot;
        if (saved.version !== 1 || saved.floor !== floor || saved.repository !== repository || !Array.isArray(saved.events) || !Array.isArray(saved.workflows)) throw new Error('Workflow journal identity/schema mismatch');
        this.data = saved;
      } catch (error) { this.data.error = `Workflow journal unavailable: ${(error as Error).message}. Restore workflows.json then restart this floor; no workflow actions will dispatch.`; }
    }
  }
  commit(change: (data: Snapshot) => void) {
    if (this.data.error) throw new Error(this.data.error);
    const next = structuredClone(this.data);
    change(next);
    if (JSON.stringify(next) === JSON.stringify(this.data)) return;
    writeDurableJson(this.file, next);
    this.data = next;
  }
  snapshot() { return structuredClone(this.data); }
}
