// /api/auth/* — sign-in with email + password, two-step verification with an authenticator
// app (ADM-03), sign-out, and password reset / invite acceptance (ADM-02, ADM-07).
import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import QRCode from 'qrcode';
import { userCtx } from '../access/context.ts';
import { writeAudit } from '../audit.ts';
import { config } from '../config.ts';
import { nowIso, one, run, tx } from '../db/connection.ts';
import { ApiError, fail } from '../errors.ts';
import { requireUser, type AppContext, type AppEnv } from '../http.ts';
import { sendMail } from '../mailer.ts';
import { ipHash, registerAttempt } from '../ratelimit.ts';
import { myAccess } from '../rpc/misc.ts';
import { decryptSecret, encryptSecret, hashPassword, passwordProblem, verifyPassword } from './crypto.ts';
import { LOCKED_MESSAGE, isLocked, recordPasswordAttempt } from './lockout.ts';
import { createSession, revokeSession, revokeUserSessions, SESSION_COOKIE, upgradeSession } from './sessions.ts';
import { consumeAuthToken, createAuthToken, passwordLink, peekAuthToken } from './tokens.ts';
import { generateTotpSecret, otpauthUri, verifyTotp } from './totp.ts';

export const authRoutes = new Hono<AppEnv>();

const BAD_LOGIN = 'Email or password is not right.';

interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  totp_secret: string | null;
  totp_pending_secret: string | null;
  totp_enabled: number;
  banned: number;
}

const userById = (id: string) => one<UserRow>('SELECT * FROM users WHERE id = ?', id);

function setSessionCookie(c: AppContext, token: string, expiresAt: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: config.production || config.siteUrl.startsWith('https://'),
    path: '/',
    expires: new Date(expiresAt),
  });
}

/** Session payload the web app keeps in its auth state. */
function sessionPayload(c: AppContext, userId: string, aal: 'aal1' | 'aal2', sessionId: string | null) {
  const user = userById(userId)!;
  const ctx = userCtx({ userId, email: user.email, sessionId, aal, ip: c.var.ctx.ip, ua: c.var.ctx.ua });
  return { user: { id: user.id, email: user.email }, aal, mfa_enrolled: user.totp_enabled === 1, access: myAccess(ctx) };
}

async function readBody(c: AppContext): Promise<Record<string, unknown>> {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

authRoutes.get('/session', (c) => {
  const ctx = c.var.ctx;
  if (!ctx.userId) return c.json({ user: null });
  return c.json(sessionPayload(c, ctx.userId, ctx.aal, ctx.sessionId));
});

authRoutes.post('/login', async (c) => {
  const body = await readBody(c);
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  if (!email || !password) fail('Enter your email and password.', 'invalid');
  const user = one<UserRow>('SELECT * FROM users WHERE email = ? COLLATE NOCASE', email);
  const { ip, ua } = c.var.ctx;
  if (!user || user.banned) {
    // Same time cost as a real check, so response times don't reveal which emails exist.
    await verifyPassword(password, 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
    fail(BAD_LOGIN, 'invalid_credentials', undefined, 400);
  }
  if (isLocked(user!.id)) {
    tx(() => recordPasswordAttempt(user!.id, false, ip, ua));
    fail(LOCKED_MESSAGE, 'locked', undefined, 429);
  }
  const ok = await verifyPassword(password, user!.password_hash);
  const outcome = tx(() => recordPasswordAttempt(user!.id, ok, ip, ua));
  if (outcome === 'locked') fail(LOCKED_MESSAGE, 'locked', undefined, 429);
  if (!ok) fail(BAD_LOGIN, 'invalid_credentials', undefined, 400);
  const session = createSession(user!.id, ip, ua);
  setSessionCookie(c, session.token, session.expiresAt);
  return c.json(sessionPayload(c, user!.id, 'aal1', session.id));
});

authRoutes.post('/logout', async (c) => {
  const ctx = c.var.ctx;
  const body = await readBody(c);
  if (ctx.sessionId) {
    tx(() => {
      writeAudit(ctx, body.reason === 'timeout' || body.reason === 'session_limit' ? 'auth.session_timeout' : 'auth.logout', 'auth', ctx.userId, null, {
        reason: body.reason ?? 'manual',
      });
      revokeSession(ctx.sessionId!);
    });
  }
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ two-step verification

/** Start enrolment: a new secret, shown once as a QR code and as text. */
authRoutes.post('/mfa/enroll', async (c) => {
  const ctx = requireUser(c);
  const user = userById(ctx.userId!)!;
  if (user.totp_enabled) fail('Two-step verification is already set up. Enter the code from your app.', 'already_enrolled', undefined, 409);
  const secret = generateTotpSecret();
  run('UPDATE users SET totp_pending_secret = ?, updated_at = ? WHERE id = ?', encryptSecret(secret), nowIso(), user.id);
  const uri = otpauthUri(user.email, secret);
  return c.json({ secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) });
});

/** Check a code: completes enrolment, or upgrades this session to two-step (aal2). */
authRoutes.post('/mfa/verify', async (c) => {
  const ctx = requireUser(c);
  if (!ctx.sessionId) fail('Sign in again.', 'unauthorized', undefined, 401);
  const body = await readBody(c);
  const code = String(body.code ?? '');
  const result = tx(() => {
    const session = one<{ mfa_failures: number }>('SELECT mfa_failures FROM sessions WHERE id = ?', ctx.sessionId);
    if (!session) fail('Sign in again.', 'unauthorized', undefined, 401);
    const user = userById(ctx.userId!)!;
    const enrolling = !user.totp_enabled;
    const stored = enrolling ? user.totp_pending_secret : user.totp_secret;
    if (!stored) fail('Set up two-step verification first.', 'not_enrolled', undefined, 400);
    if (!verifyTotp(decryptSecret(stored!), code)) {
      if (session!.mfa_failures + 1 >= 5) {
        revokeSession(ctx.sessionId!);
        writeAudit(ctx, 'auth.mfa_failed', 'auth', ctx.userId, null, { locked_out: true });
        return { ok: false as const, signedOut: true };
      }
      run('UPDATE sessions SET mfa_failures = mfa_failures + 1 WHERE id = ?', ctx.sessionId);
      writeAudit(ctx, 'auth.mfa_failed', 'auth', ctx.userId);
      return { ok: false as const, signedOut: false };
    }
    if (enrolling) {
      run('UPDATE users SET totp_secret = totp_pending_secret, totp_pending_secret = NULL, totp_enabled = 1, updated_at = ? WHERE id = ?', nowIso(), user.id);
      writeAudit(ctx, 'auth.mfa_enrolled', 'auth', ctx.userId);
    } else {
      writeAudit(ctx, 'auth.mfa_verified', 'auth', ctx.userId);
    }
    upgradeSession(ctx.sessionId!);
    return { ok: true as const, signedOut: false };
  });
  if (!result.ok) {
    if (result.signedOut) {
      deleteCookie(c, SESSION_COOKIE, { path: '/' });
      throw new ApiError('Too many wrong codes. Sign in again.', 'mfa_locked', { status: 429 });
    }
    fail('That code is not right, or it expired. Try the current code.', 'invalid_code');
  }
  return c.json(sessionPayload(c, ctx.userId!, 'aal2', ctx.sessionId));
});

// ------------------------------------------------------------------ passwords

/** Always answers the same way, so it can't be used to find out which emails have accounts. */
authRoutes.post('/password/forgot', async (c) => {
  const body = await readBody(c);
  const email = String(body.email ?? '').trim().toLowerCase();
  const { ip } = c.var.ctx;
  const user = email ? one<{ id: string; email: string }>(
    `SELECT u.id, u.email FROM users u JOIN staff_profiles p ON p.user_id = u.id WHERE u.email = ? COLLATE NOCASE AND u.banned = 0 AND p.active = 1`,
    email,
  ) : undefined;
  if (user) {
    const allowed = tx(() => registerAttempt('reset', user.email, ipHash(ip, config.rateLimitSalt), 3, 20));
    if (allowed) {
      const token = tx(() => createAuthToken(user.id, 'reset'));
      await sendMail(
        [user.email],
        'Reset your KSR admin password',
        `Someone asked to reset the password for ${user.email}.\n\nChoose a new password here (the link works for 1 hour):\n${passwordLink(token, 'reset')}\n\nIf this wasn't you, ignore this email.`,
      );
    }
  }
  return c.json({ ok: true });
});

authRoutes.get('/password/token', (c) => {
  const info = peekAuthToken(c.req.query('token') ?? '');
  return c.json(info ? { valid: true, kind: info.kind, email: info.email } : { valid: false });
});

/** Set a password from an invite or reset link; signs the person in (two-step comes next). */
authRoutes.post('/password/reset', async (c) => {
  const body = await readBody(c);
  const password = String(body.password ?? '');
  const problem = passwordProblem(password);
  if (problem) fail(problem, 'password');
  const hash = await hashPassword(password);
  const info = tx(() => {
    const t = consumeAuthToken(String(body.token ?? ''));
    if (!t) fail('This link has expired or was already used. Ask for a new one.', 'link_invalid', undefined, 410);
    run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hash, nowIso(), t!.userId);
    revokeUserSessions(t!.userId);
    writeAudit(c.var.ctx, t!.kind === 'invite' ? 'auth.invite_accepted' : 'auth.password_reset', 'auth', t!.userId, null, null, { actorId: t!.userId });
    return t!;
  });
  const session = createSession(info.userId, c.var.ctx.ip, c.var.ctx.ua);
  setSessionCookie(c, session.token, session.expiresAt);
  return c.json(sessionPayload(c, info.userId, 'aal1', session.id));
});
