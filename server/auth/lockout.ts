// Login lockout (ADM-06) and login audit (AUD-01) — port of hook_password_verification_attempt.
// 5 failed passwords within 15 minutes (since the last success) lock the account for
// 15 minutes, and the Owner gets an email.
import { formatWhen } from '../../shared/time.ts';
import { anonCtx } from '../access/context.ts';
import { writeAudit } from '../audit.ts';
import { nowIso, one, run, uuid } from '../db/connection.ts';
import { enqueueEmail, recipients } from '../outbox.ts';

export const LOCKED_MESSAGE = 'Too many failed attempts. Try again in 15 minutes.';

export function isLocked(userId: string): boolean {
  const row = one<{ locked_until: string }>('SELECT locked_until FROM account_locks WHERE user_id = ?', userId);
  return Boolean(row && row.locked_until > nowIso());
}

/**
 * Record a password check. Returns 'locked' when the account is (now) locked; the caller
 * must then refuse the sign-in even if the password was right.
 */
export function recordPasswordAttempt(userId: string, ok: boolean, ip: string | null, ua: string | null): 'continue' | 'locked' {
  const ctx = { ...anonCtx(ip, ua) };
  const now = nowIso();
  if (isLocked(userId)) {
    writeAudit(ctx, 'auth.login_blocked', 'auth', userId, null, null, { actorId: userId });
    return 'locked';
  }
  run('INSERT INTO login_attempts (id, user_id, succeeded, at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', uuid(), userId, ok ? 1 : 0, now, now, now);

  if (ok) {
    run('DELETE FROM account_locks WHERE user_id = ?', userId);
    run('UPDATE staff_profiles SET last_seen_at = ? WHERE user_id = ?', now, userId);
    writeAudit(ctx, 'auth.login', 'auth', userId, null, null, { actorId: userId });
    return 'continue';
  }

  writeAudit(ctx, 'auth.login_failed', 'auth', userId, null, null, { actorId: userId });
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const lastSuccess = one<{ at: string }>('SELECT max(at) AS at FROM login_attempts WHERE user_id = ? AND succeeded = 1', userId)?.at ?? '';
  const fails = one<{ n: number }>(
    'SELECT count(*) AS n FROM login_attempts WHERE user_id = ? AND succeeded = 0 AND at > ? AND at > ?',
    userId,
    since,
    lastSuccess,
  )!.n;
  if (fails < 5) return 'continue';

  run(
    `INSERT INTO account_locks (user_id, locked_until, id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET locked_until = excluded.locked_until, updated_at = excluded.updated_at`,
    userId,
    new Date(Date.now() + 15 * 60_000).toISOString(),
    uuid(),
    now,
    now,
  );
  const email = one<{ email: string }>('SELECT email FROM users WHERE id = ?', userId)?.email ?? userId;
  enqueueEmail(
    'lockout',
    recipients('lockout_emails', ['owner']),
    `Admin account locked: ${email}`,
    `The admin account ${email} was locked for 15 minutes after 5 failed sign-in attempts at ${formatWhen(now)}. If this wasn't them, deactivate the account in Staff.`,
    { user_id: userId, path: '/admin/staff' },
    `lockout:${userId}:${now.slice(0, 16)}`,
  );
  return 'locked';
}
