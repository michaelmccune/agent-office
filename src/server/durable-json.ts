import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Atomic file replacement; callers must surface errors before acknowledging durable work. */
export function writeDurableJson(file: string, data: unknown) {
  const temp = `${file}.tmp`;
  const fd = openSync(temp, 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(data, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, file);
  if (process.platform !== 'win32') {
    const dir = openSync(path.dirname(file), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }
}
