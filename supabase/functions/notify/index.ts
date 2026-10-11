// notify (cron / internal, P0 email; Section 11).
// POST (optional JSON { limit?: number }) with header x-cron-secret: <CRON_SECRET>
//   or Authorization: Bearer <service-role key>.
// Sends up to `limit` (default 50) pending outbox rows, oldest first.
// 200 { ok: true, picked, sent, retrying, failed, skipped }
import { isInternalRequest } from '../_shared/auth.ts';
import { serviceClient } from '../_shared/clients.ts';
import { allowMethods, handler, HttpError, json, readJson } from '../_shared/http.ts';
import { drainOutbox } from '../_shared/outbox.ts';

Deno.serve(
  handler('notify', async (req) => {
    allowMethods(req, ['POST']);
    if (!(await isInternalRequest(req))) throw new HttpError(401, 'Not allowed.', 'unauthorized');
    const body = await readJson(req);
    const requested = Number(body.limit);
    const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 50) : 50;
    const result = await drainOutbox(serviceClient(), limit);
    return json({ ok: true, ...result });
  }),
);
