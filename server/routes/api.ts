// POST /api/query (data API) and POST /api/rpc/<name> (business functions).
import { Hono } from 'hono';
import { tx } from '../db/connection.ts';
import { ApiError } from '../errors.ts';
import type { AppEnv } from '../http.ts';
import { executeQuery, type QueryRequest } from '../query/engine.ts';
import { getRpc } from '../rpc/index.ts';

export const apiRoutes = new Hono<AppEnv>();

async function body<T>(req: { json: () => Promise<unknown> }): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

apiRoutes.post('/query', async (c) => {
  const req = await body<QueryRequest>(c.req);
  const ctx = c.var.ctx;
  const result = req.action === 'select' ? executeQuery(ctx, req) : tx(() => executeQuery(ctx, req));
  return c.json(result);
});

apiRoutes.post('/rpc/:name', async (c) => {
  const def = getRpc(c.req.param('name'));
  if (!def) throw new ApiError('Unknown function.', 'not_found', { status: 404, pgCode: 'PGRST202' });
  const ctx = c.var.ctx;
  if (def.access === 'user' && !ctx.userId) throw new ApiError('Sign in to continue.', 'unauthorized', { status: 401, pgCode: 'PGRST301' });
  const args = await body<Record<string, unknown>>(c.req);
  // One transaction per call: a failure part-way rolls back everything, like a Postgres function.
  const result = tx(() => def.handler(ctx, args));
  return c.json(result ?? null);
});
