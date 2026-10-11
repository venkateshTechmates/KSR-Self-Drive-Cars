// Who is making a request: the signed-in user, their role, and whether two-step
// verification is satisfied. Replaces auth.uid() / my_role() from the Supabase version.
import type { AppRole } from '../../shared/constants.ts';
import { one } from '../db/connection.ts';
import { getSetting } from '../settings.ts';

export interface Ctx {
  userId: string | null;
  email: string | null;
  sessionId: string | null;
  aal: 'aal1' | 'aal2';
  /** Role of an active staff account, ignoring two-step status. */
  roleRaw: AppRole | null;
  /** Role usable for data access (null until two-step is done where required, ADM-03). */
  role: AppRole | null;
  ip: string | null;
  ua: string | null;
  /** Scheduled jobs and internal calls: bypass role checks. Never set from a request. */
  system: boolean;
}

export function anonCtx(ip: string | null = null, ua: string | null = null): Ctx {
  return { userId: null, email: null, sessionId: null, aal: 'aal1', roleRaw: null, role: null, ip, ua, system: false };
}

export function systemCtx(): Ctx {
  return { ...anonCtx(), system: true };
}

export function mfaRequired(role: AppRole): boolean {
  return getSetting('security').mfa_required_roles.includes(role);
}

/** Active staff role for a user, or null (deactivated, banned or no role). */
export function activeRole(userId: string): AppRole | null {
  const row = one<{ role: AppRole }>(
    `SELECT r.role FROM user_roles r
       JOIN staff_profiles p ON p.user_id = r.user_id
       JOIN users u ON u.id = r.user_id
      WHERE r.user_id = ? AND p.active = 1 AND u.banned = 0`,
    userId,
  );
  return row?.role ?? null;
}

export function userCtx(opts: { userId: string; email: string | null; sessionId: string | null; aal: 'aal1' | 'aal2'; ip: string | null; ua: string | null }): Ctx {
  const roleRaw = activeRole(opts.userId);
  const role = roleRaw && (!mfaRequired(roleRaw) || opts.aal === 'aal2') ? roleRaw : null;
  return { userId: opts.userId, email: opts.email, sessionId: opts.sessionId, aal: opts.aal, roleRaw, role, ip: opts.ip, ua: opts.ua, system: false };
}

export const isOwner = (ctx: Ctx) => ctx.system || ctx.role === 'owner';
export const isOwnerOrManager = (ctx: Ctx) => ctx.system || ctx.role === 'owner' || ctx.role === 'manager';
export const isAdmin = (ctx: Ctx) => ctx.system || ctx.role !== null;
export const isStaffRole = (ctx: Ctx) => !ctx.system && ctx.role === 'staff';
