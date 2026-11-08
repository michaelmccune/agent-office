import type http from 'node:http';
import { DESK_BY_ID } from '../../shared/layout.js';
import type { Ctx } from '../office/context.js';
import { readBody, send } from '../http/util.js';
import type { Actor, Review, Verification } from './types.js';

/** Authenticated worker API. Role, account, floor and repository never come from the payload. */
export async function officeWorkflow(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const id = url.searchParams.get('worker') ?? '';
  const floor = ctx.workerFloor(id);
  const me = floor?.workers.authenticate(id, (req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
  if (!floor || !me || me.kind !== 'agent') return send(res, 401, { error: 'Use your running worker ID and bearer token' });
  const actor: Actor = { id, role: DESK_BY_ID.get(me.deskId)?.station ?? 'worker', owner: floor.workers.ownerOf(id) };
  const view = () => {
    const data = floor.workflows.snapshot();
    return { ...data, workflows: data.workflows.filter((w) => w.owner === actor.owner && (actor.role !== 'worker' || w.worker === id)),
      events: data.events.filter((e) => e.owner === actor.owner && (actor.role !== 'worker' || e.worker === id)) };
  };
  if (req.method === 'GET' && url.pathname === '/office/workflow') return send(res, 200, view());
  if (req.method !== 'POST') return send(res, 405, { error: 'GET list or POST ready/plan/review/complete/ack' });
  try {
    const b = JSON.parse(await readBody(req));
    if (!b || Array.isArray(b) || typeof b !== 'object') throw new Error('Send a JSON object');
    const action = url.pathname.slice('/office/workflow/'.length);
    if (action === 'ready') await floor.workflows.ready(actor, { issues: b.issues, criteria: b.criteria, dependencies: b.dependencies ?? [], context: b.context, authorized: b.authorized === true });
    else if (action === 'plan') floor.workflows.plan(actor, String(b.event ?? ''), { title: b.title, prompt: b.prompt });
    else if (action === 'review') floor.workflows.review(actor, String(b.event ?? ''), b as Review);
    else if (action === 'complete') floor.workflows.complete(actor, String(b.workflow ?? ''), { pr: b.pr, head: b.head, results: b.results as Verification[] });
    else if (action === 'ack') floor.workflows.ack(actor, String(b.event ?? ''), b.outcome);
    else throw new Error('Unknown worker action; human controls require the signed-in session API');
    send(res, 200, view());
  } catch (error) { send(res, 409, { error: (error as Error).message }); }
}
