// Shared HTTP plumbing for the Hono app: request context, client IP, CSRF guard, errors.
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { anonCtx, userCtx, type Ctx } from './access/context.ts';
import { SESSION_COOKIE, findSession } from './auth/sessions.ts';
import { config } from './config.ts';
import { ApiError, errorBody, toApiError } from './errors.ts';

export type AppEnv = {
  Variables: { ctx: Ctx };
  Bindings: { incoming?: { socket?: { remoteAddress?: string } } };
};

export type AppContext = Context<AppEnv>;

export function clientIp(c: AppContext): string | null {
  if (config.trustProxy) {
    const xff = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (xff) return xff;
    const real = c.req.header('fly-client-ip') ?? c.req.header('cf-connecting-ip') ?? c.req.header('x-real-ip');
    if (real) return real;
  }
  return c.env?.incoming?.socket?.remoteAddress ?? null;
}

/** Resolve the caller (session cookie → user, role, two-step level) into c.var.ctx. */
export const contextMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ip = clientIp(c);
  const ua = c.req.header('user-agent') ?? null;
  const session = findSession(getCookie(c, SESSION_COOKIE));
  c.set('ctx', session ? userCtx({ userId: session.user_id, email: session.email, sessionId: session.id, aal: session.aal, ip, ua }) : anonCtx(ip, ua));
  await next();
};

/**
 * CSRF guard: state-changing API calls must carry the X-KSR-Request header, which a
 * cross-site form or link can't add (the session cookie is also SameSite=Lax).
 */
export const csrfGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const m = c.req.method;
  if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS' && c.req.header('x-ksr-request') !== '1') {
    return c.json({ message: 'Missing request header.', details: 'csrf', hint: null, code: '42501', error: 'Missing request header.' }, 403);
  }
  await next();
};

/** The signed-in caller, or a 401 error. */
export function requireUser(c: AppContext): Ctx {
  const ctx = c.var.ctx;
  if (!ctx.userId) throw new ApiError('Sign in to continue.', 'unauthorized', { status: 401, pgCode: 'PGRST301' });
  return ctx;
}

/**
 * Error responses. Data and RPC calls use the Postgres/PostgREST shape the web app's
 * toAppError() understands; /api/fn/* (the former edge functions) use { error, code, hint }.
 */
export function errorResponse(c: AppContext, err: unknown): Response {
  const e = toApiError(err);
  const status = e.status as 400;
  if (c.req.path.startsWith('/api/fn/')) {
    return c.json({ error: e.message, code: e.detail, hint: e.hint ?? undefined }, status);
  }
  return c.json(errorBody(e), status);
}
