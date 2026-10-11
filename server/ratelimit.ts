// Sliding one-hour rate limits (BK-11 and friends), counted per mobile number and per hashed IP.
import { createHash } from 'node:crypto';
import { nowIso, one, run, uuid } from './db/connection.ts';

export type LimitKind = 'booking' | 'lookup' | 'upload' | 'mfa' | 'reset';

/** Hash an IP with the server salt so raw addresses are never stored for rate limiting. */
export function ipHash(ip: string | null, salt: string): string | null {
  return ip ? createHash('sha256').update(`${salt}:${ip}`).digest('hex') : null;
}

/**
 * Record an attempt if it is within the limits; returns false (and records nothing) when
 * the phone or IP already reached its hourly limit. A limit of 0 means "don't check".
 */
export function registerAttempt(kind: LimitKind, phone: string | null, ipHashValue: string | null, maxPhone: number, maxIp: number): boolean {
  const since = new Date(Date.now() - 3_600_000).toISOString();
  if (phone && maxPhone > 0) {
    const n = one<{ n: number }>('SELECT count(*) AS n FROM submission_attempts WHERE kind = ? AND phone = ? AND at > ?', kind, phone, since)!.n;
    if (n >= maxPhone) return false;
  }
  if (ipHashValue && maxIp > 0) {
    const n = one<{ n: number }>('SELECT count(*) AS n FROM submission_attempts WHERE kind = ? AND ip_hash = ? AND at > ?', kind, ipHashValue, since)!.n;
    if (n >= maxIp) return false;
  }
  const now = nowIso();
  run('INSERT INTO submission_attempts (id, kind, phone, ip_hash, at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', uuid(), kind, phone, ipHashValue, now, now, now);
  return true;
}
