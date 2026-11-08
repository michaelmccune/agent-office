#!/usr/bin/env node
// Durable handoffs use the same authenticated loopback identity as office-queue. No auto-approval
// grants are added: shell/API calls remain subject to the provider's native permission controls.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { officeEnv } from './office-queue.js';

export async function main(argv, io = {}) {
  const out = io.out ?? ((text) => process.stdout.write(text + '\n'));
  const err = io.err ?? ((text) => process.stderr.write(text + '\n'));
  try {
    const [action, ...args] = argv;
    if (!action || ['--help', 'help'].includes(action)) {
      out('office-workflow list\noffice-workflow ready --json \'{"issues":[12],"criteria":["…"],"context":"original authorized request","authorized":true}\'\noffice-workflow plan|review|ack <event-id> --json \'{…}\'\noffice-workflow complete <workflow-id> --json \'{"pr":123,"head":"SHA","results":[{"command":"npm test","result":"pass","detail":"…"}]}\'\nHuman pause/resume/cancel/retry/authorize/replace controls: authenticated /api/workflows (see docs/workflows.md).');
      return 0;
    }
    if (!['list', 'ready', 'plan', 'review', 'ack', 'complete'].includes(action)) throw new Error('Unknown action; use --help');
    const office = officeEnv(io.env ?? process.env);
    const url = new URL(`${office.url}/office/workflow${action === 'list' ? '' : '/' + action}`);
    url.searchParams.set('worker', office.worker);
    let payload;
    if (action !== 'list') {
      const needsId = !['ready'].includes(action);
      if (args.length !== (needsId ? 3 : 2) || args[needsId ? 1 : 0] !== '--json') throw new Error('Use <event/workflow ID> --json \'{…}\' (ready needs no ID)');
      payload = JSON.parse(args[needsId ? 2 : 1]);
      if (!payload || Array.isArray(payload) || typeof payload !== 'object') throw new Error('--json must be an object');
      if (needsId) payload[action === 'complete' ? 'workflow' : 'event'] = args[0];
    } else if (args.length) throw new Error('list takes no arguments');
    const response = await (io.fetch ?? fetch)(url.href, { method: action === 'list' ? 'GET' : 'POST', headers: { authorization: `Bearer ${office.token}`, 'content-type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(30_000) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    out(JSON.stringify(body, null, 2));
    return 0;
  } catch (error) { err(`office-workflow: ${error.message}`); return 1; }
}
const invoked = (() => { try { return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invoked) process.exitCode = await main(process.argv.slice(2));
