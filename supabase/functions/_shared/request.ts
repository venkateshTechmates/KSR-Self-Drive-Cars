// Request metadata for audit entries, consents and rate limiting. IP addresses are only
// stored where the audit/consent records need them; rate limiting uses a salted hash.
import { sha256Hex } from './domain/documents.ts';
import { env } from './env.ts';

/** Caller's IP: first x-forwarded-for entry, then cf-connecting-ip, then x-real-ip. */
export function clientIp(req: Request): string | null {
  const forwarded = req.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  if (first) return first;
  const cf = req.headers.get('cf-connecting-ip')?.trim();
  if (cf) return cf;
  const real = req.headers.get('x-real-ip')?.trim();
  return real || null;
}

/** User agent, truncated to what the database keeps. */
export function userAgent(req: Request): string | null {
  const ua = req.headers.get('user-agent');
  return ua ? ua.slice(0, 400) : null;
}

/** sha256 hex of `${RATE_LIMIT_SALT}:${ip}`, or null when the IP is unknown. */
export async function ipHash(ip: string | null): Promise<string | null> {
  if (!ip) return null;
  const salt = env('RATE_LIMIT_SALT') ?? '';
  return await sha256Hex(new TextEncoder().encode(`${salt}:${ip}`));
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export function requestMeta(req: Request): RequestMeta {
  return { ip: clientIp(req), userAgent: userAgent(req) };
}
