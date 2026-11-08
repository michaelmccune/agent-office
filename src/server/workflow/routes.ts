import type { Route } from '../http/router.js';
import { readBody, send } from '../http/util.js';
import { floorParam } from '../http/routes/files.js';

/** A CLI-inspectable JSON surface using the office's ordinary session authentication. Worker-token
 * endpoints intentionally cannot change human authority or acknowledge a human-required decision. */
export const workflowRoute: Route = {
  auth: 'session', prefix: '/api/workflows',
  async handle(ctx, { req, res, url, session }) {
    const floor = floorParam(ctx, url);
    if (!floor) return send(res, 404, { error: 'No such floor' });
    const owner = session.account?.id;
    if (req.method === 'GET') {
      const data = floor.workflows.snapshot();
      return send(res, 200, { ...data, workflows: data.workflows.filter((w) => w.owner === owner), events: data.events.filter((e) => e.owner === owner) });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'GET or POST' });
    // Match the office's same-origin socket model. Cross-origin browser forms cannot grant authority.
    if (!req.headers['content-type']?.startsWith('application/json')) return send(res, 415, { error: 'application/json is required' });
    if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return send(res, 403, { error: 'Same-origin controls only' });
    try {
      const body = JSON.parse(await readBody(req));
      floor.workflows.control(owner, String(body.workflow ?? ''), String(body.action ?? ''), body);
      send(res, 200, { ok: true });
    } catch (error) { send(res, 409, { error: (error as Error).message }); }
  },
};
