// Sessions: an HttpOnly cookie holds a random token; the database stores only its SHA-256.
// Sessions end after the Settings › security limit (12 hours by default, ADM-05), on sign-out,
// and immediately when an account is deactivated (ADM-07).
import { getSetting } from '../settings.ts';
import { nowIso, one, run } from '../db/connection.ts';
import { randomToken, sha256Hex } from './crypto.ts';

export const SESSION_COOKIE = 'ksr_session';

export interface SessionRow {
  id: string;
  user_id: string;
  aal: 'aal1' | 'aal2';
  mfa_failures: number;
  expires_at: string;
  last_seen_at: string;
  email: string;
}

export function sessionHours(): number {
  const h = Number(getSetting('security').session_hours);
  return Number.isFinite(h) && h > 0 ? Math.min(h, 12) : 12;
}

export function createSession(userId: string, ip: string | null, ua: string | null): { id: string; token: string; expiresAt: string } {
  const token = randomToken();
  const now = nowIso();
  const expiresAt = new Date(Date.now() + sessionHours() * 3_600_000).toISOString();
  run(
    `INSERT INTO sessions (id, user_id, aal, ip, user_agent, expires_at, last_seen_at, created_at, updated_at)
     VALUES (?, ?, 'aal1', ?, ?, ?, ?, ?, ?)`,
    sha256Hex(token),
    userId,
    ip,
    ua?.slice(0, 400) ?? null,
    expiresAt,
    now,
    now,
    now,
  );
  return { id: sha256Hex(token), token, expiresAt };
}

/** The live session for a cookie token, or null (expired, revoked, banned user). */
export function findSession(token: string | undefined): SessionRow | null {
  if (!token) return null;
  const row = one<SessionRow>(
    `SELECT s.id, s.user_id, s.aal, s.mfa_failures, s.expires_at, s.last_seen_at, u.email
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND u.banned = 0`,
    sha256Hex(token),
  );
  if (!row) return null;
  const now = nowIso();
  if (row.expires_at <= now) {
    run('DELETE FROM sessions WHERE id = ?', row.id);
    return null;
  }
  // Touch at most once a minute.
  if (Date.parse(now) - Date.parse(row.last_seen_at) > 60_000) run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', now, row.id);
  return row;
}

export function upgradeSession(sessionId: string): void {
  run(`UPDATE sessions SET aal = 'aal2', mfa_failures = 0, updated_at = ? WHERE id = ?`, nowIso(), sessionId);
}

export function revokeSession(sessionId: string): void {
  run('DELETE FROM sessions WHERE id = ?', sessionId);
}

/** End every session of a user (deactivation, password reset). */
export function revokeUserSessions(userId: string, exceptSessionId: string | null = null): void {
  run('DELETE FROM sessions WHERE user_id = ? AND id IS NOT ?', userId, exceptSessionId);
}

export function purgeExpiredSessions(): number {
  return run('DELETE FROM sessions WHERE expires_at <= ?', nowIso()).changes;
}
