// Machine-to-machine authentication: the cron secret (pg_cron via pg_net) and the
// service-role key. Comparisons are constant-time.
import { env } from './env.ts';

/** Bearer token from the Authorization header, or null. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

/** Constant-time string comparison (hashes both sides so lengths don't leak). */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** True when the x-cron-secret header matches CRON_SECRET. False if CRON_SECRET is unset. */
export async function isCronRequest(req: Request): Promise<boolean> {
  const secret = env('CRON_SECRET');
  const given = req.headers.get('x-cron-secret');
  if (!secret || !given) return false;
  return await timingSafeEqual(given, secret);
}

/** True when the bearer token is this project's service-role key. */
export async function isServiceRoleRequest(req: Request): Promise<boolean> {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const token = bearerToken(req);
  if (!key || !token) return false;
  return await timingSafeEqual(token, key);
}

/** Cron secret or service-role key. */
export async function isInternalRequest(req: Request): Promise<boolean> {
  return (await isCronRequest(req)) || (await isServiceRoleRequest(req));
}
