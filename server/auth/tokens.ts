// Single-use links for staff invites (7 days) and password resets (1 hour). Only the
// SHA-256 of the token is stored.
import { config } from '../config.ts';
import { nowIso, one, run, uuid } from '../db/connection.ts';
import { randomToken, sha256Hex } from './crypto.ts';

export type AuthTokenKind = 'invite' | 'reset';

const TTL_HOURS: Record<AuthTokenKind, number> = { invite: 7 * 24, reset: 1 };

/** Create a token (cancelling earlier unused ones of the same kind) and return the raw value. */
export function createAuthToken(userId: string, kind: AuthTokenKind): string {
  const token = randomToken();
  const now = nowIso();
  run(`UPDATE auth_tokens SET used_at = ?, updated_at = ? WHERE user_id = ? AND kind = ? AND used_at IS NULL`, now, now, userId, kind);
  run(
    `INSERT INTO auth_tokens (id, user_id, kind, token_hash, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    uuid(),
    userId,
    kind,
    sha256Hex(token),
    new Date(Date.now() + TTL_HOURS[kind] * 3_600_000).toISOString(),
    now,
    now,
  );
  return token;
}

/** Link to the page where the person sets a password. */
export const passwordLink = (token: string, kind: AuthTokenKind) =>
  `${config.siteUrl}/admin/reset-password?token=${encodeURIComponent(token)}${kind === 'invite' ? '&invite=1' : ''}`;

export interface TokenInfo {
  id: string;
  userId: string;
  kind: AuthTokenKind;
  email: string;
}

/** A valid (unused, unexpired) token, without using it up. */
export function peekAuthToken(token: string): TokenInfo | null {
  const row = one<{ id: string; user_id: string; kind: AuthTokenKind; email: string }>(
    `SELECT t.id, t.user_id, t.kind, u.email FROM auth_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ? AND t.used_at IS NULL AND t.expires_at > ? AND u.banned = 0`,
    sha256Hex(token),
    nowIso(),
  );
  return row ? { id: row.id, userId: row.user_id, kind: row.kind, email: row.email } : null;
}

export function consumeAuthToken(token: string): TokenInfo | null {
  const info = peekAuthToken(token);
  if (!info) return null;
  const now = nowIso();
  run('UPDATE auth_tokens SET used_at = ?, updated_at = ? WHERE id = ?', now, now, info.id);
  return info;
}
