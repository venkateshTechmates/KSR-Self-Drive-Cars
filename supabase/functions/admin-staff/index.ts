// admin-staff (Owner only, P0; SET-05, ADM-02, ADM-07).
// POST JSON { action, ... }:
//   invite         { email, full_name, role, phone? }
//   set_role       { user_id, role }
//   deactivate     { user_id }            ends their sessions (ban) and blocks data access at once
//   reactivate     { user_id }
//   resend_invite  { user_id }            invite again, or a password-reset email if already joined
//   update_profile { user_id, full_name?, phone? }
// 200 { ok: true, user_id }
// The caller must be an active Owner with two-step verification done (effective_role 'owner').
import { APP_ROLES, type AppRole } from '../_shared/domain/constants.ts';
import { MESSAGES, normalizePhone, validateEmail } from '../_shared/domain/validation.ts';
import {
  type AuthError,
  type Client,
  requireRole,
  requireUser,
  serviceClient,
  type UserContext,
} from '../_shared/clients.ts';
import { siteUrl } from '../_shared/env.ts';
import { allowMethods, fromPgError, handler, HttpError, json, readJson, requireUuid, str } from '../_shared/http.ts';
import { clientIp, userAgent } from '../_shared/request.ts';

/** About 100 years: effectively permanent until reactivated. */
const BAN_FOREVER = '876000h';

interface StaffRow {
  user_id: string;
  full_name: string;
  email: string;
  phone: string | null;
  active: boolean;
  role: AppRole | null;
}

interface Ctx {
  user: UserContext;
  service: Client;
  req: Request;
  body: Record<string, unknown>;
}

const invalid = (field: string, message: string) => new HttpError(422, message, 'validation', { [field]: message });
const notFound = () => new HttpError(404, 'Staff member not found.', 'not_found');

// ---------------------------------------------------------------- input

function parseRole(value: unknown): AppRole {
  const role = str(value);
  if (!(APP_ROLES as readonly string[]).includes(role)) throw invalid('role', 'Choose Owner, Manager or Staff.');
  return role as AppRole;
}

function parseName(value: unknown): string {
  const name = str(value).replace(/\s+/g, ' ');
  if (name.length < 1 || [...name].length > 80) throw invalid('full_name', 'Enter a name of up to 80 characters.');
  return name;
}

function parseEmail(value: unknown): string {
  const email = str(value).toLowerCase();
  if (!email) throw invalid('email', 'Enter an email address.');
  const err = validateEmail(email);
  if (err) throw invalid('email', err);
  return email;
}

/** Optional mobile: '' clears it, anything else must be a valid Indian mobile. */
function parsePhone(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  const phone = normalizePhone(raw);
  if (!phone) throw invalid('phone', MESSAGES.phoneInvalid);
  return phone;
}

// ---------------------------------------------------------------- data helpers

async function loadStaff(service: Client, userId: string): Promise<StaffRow> {
  const [{ data: profile, error: profileError }, { data: role, error: roleError }] = await Promise.all([
    service.from('staff_profiles').select('user_id, full_name, email, phone, active').eq('user_id', userId).maybeSingle(),
    service.from('user_roles').select('role').eq('user_id', userId).maybeSingle(),
  ]);
  if (profileError) throw fromPgError(profileError, 'admin-staff');
  if (roleError) throw fromPgError(roleError, 'admin-staff');
  if (!profile) throw notFound();
  return { ...(profile as Omit<StaffRow, 'role'>), role: ((role as { role?: AppRole } | null)?.role ?? null) };
}

/** Active Owners other than `userId`. */
async function otherActiveOwners(service: Client, userId: string): Promise<number> {
  const { data: owners, error } = await service.from('user_roles').select('user_id').eq('role', 'owner').neq('user_id', userId);
  if (error) throw fromPgError(error, 'admin-staff');
  const ids = ((owners ?? []) as Array<{ user_id: string }>).map((o) => o.user_id);
  if (ids.length === 0) return 0;
  const { count, error: countError } = await service
    .from('staff_profiles')
    .select('user_id', { count: 'exact', head: true })
    .in('user_id', ids)
    .eq('active', true);
  if (countError) throw fromPgError(countError, 'admin-staff');
  return count ?? 0;
}

async function ensureNotLastOwner(service: Client, staff: StaffRow): Promise<void> {
  if (staff.role === 'owner' && staff.active && (await otherActiveOwners(service, staff.user_id)) === 0) {
    throw new HttpError(409, 'There must always be at least one active Owner.', 'last_owner');
  }
}

/** Explicit audit entry with the Owner as actor (row triggers can't see who called). */
async function audit(
  c: Ctx,
  action: string,
  userId: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Promise<void> {
  const { error } = await c.service.rpc('write_audit', {
    p_action: action,
    p_entity_type: 'staff_profiles',
    p_entity_id: userId,
    p_before: before,
    p_after: after,
    p_actor: c.user.user.id,
    p_ip: clientIp(c.req),
    p_user_agent: userAgent(c.req),
  });
  if (error) console.error('[admin-staff] audit failed', action, error.code ?? '', error.message ?? '');
}

function redirectTo(req: Request): string | undefined {
  const site = siteUrl(req);
  return site ? `${site}/admin/reset-password` : undefined;
}

const alreadyRegistered = (error: AuthError) =>
  error.code === 'email_exists' ||
  error.code === 'user_already_exists' ||
  /already (been )?registered|already exists/i.test(error.message ?? '');

function authFailure(error: AuthError, fallback: string): HttpError {
  if (error.status === 429 || String(error.code ?? '').startsWith('over_')) {
    return new HttpError(429, 'Too many emails sent. Try again in a few minutes.', 'rate_limited');
  }
  console.error('[admin-staff] auth error', error.code ?? '', error.status ?? '', error.message ?? '');
  return new HttpError(502, fallback, 'auth_failed');
}

async function setBan(c: Ctx, userId: string, duration: string, failMessage: string): Promise<void> {
  const { error } = await c.service.auth.admin.updateUserById(userId, { ban_duration: duration });
  if (error) throw authFailure(error, failMessage);
}

// ---------------------------------------------------------------- actions

async function invite(c: Ctx): Promise<string> {
  const email = parseEmail(c.body.email);
  const fullName = parseName(c.body.full_name);
  const role = parseRole(c.body.role);
  const phone = parsePhone(c.body.phone);

  const { data: existing, error: existingError } = await c.service
    .from('staff_profiles')
    .select('user_id')
    .eq('email', email)
    .maybeSingle();
  if (existingError) throw fromPgError(existingError, 'admin-staff');
  if (existing) throw new HttpError(409, 'This email already has an account.', 'exists');

  const { data, error } = await c.service.auth.admin.inviteUserByEmail(email, {
    redirectTo: redirectTo(c.req),
    data: { full_name: fullName },
  });
  if (error) {
    if (alreadyRegistered(error)) throw new HttpError(409, 'This email already has an account.', 'exists');
    throw authFailure(error, "Couldn't send the invite. Try again.");
  }
  const userId = data.user.id;

  const { error: profileError } = await c.service
    .from('staff_profiles')
    .insert({ user_id: userId, full_name: fullName, email, phone });
  const { error: roleError } = profileError
    ? { error: null }
    : await c.service.from('user_roles').insert({ user_id: userId, role });
  if (profileError || roleError) {
    // Undo the invite so the Owner can simply try again.
    const { error: deleteError } = await c.service.auth.admin.deleteUser(userId);
    if (deleteError) console.error('[admin-staff] could not undo invite', deleteError.message ?? '');
    throw fromPgError((profileError ?? roleError)!, 'admin-staff');
  }

  await audit(c, 'staff.invite', userId, null, { email, full_name: fullName, role, phone });
  return userId;
}

async function setRole(c: Ctx): Promise<string> {
  const userId = requireUuid(c.body.user_id, 'user_id', 'Staff member not found.');
  const role = parseRole(c.body.role);
  if (userId === c.user.user.id) throw new HttpError(400, "You can't change your own role.", 'self');
  const staff = await loadStaff(c.service, userId);
  if (staff.role === role) return userId;
  if (role !== 'owner') await ensureNotLastOwner(c.service, staff);

  const { error } = await c.service.from('user_roles').upsert({ user_id: userId, role }, { onConflict: 'user_id' });
  if (error) throw fromPgError(error, 'admin-staff');
  await audit(c, 'staff.role_change', userId, { role: staff.role }, { role });
  return userId;
}

async function deactivate(c: Ctx): Promise<string> {
  const userId = requireUuid(c.body.user_id, 'user_id', 'Staff member not found.');
  if (userId === c.user.user.id) throw new HttpError(400, "You can't deactivate your own account.", 'self');
  const staff = await loadStaff(c.service, userId);
  await ensureNotLastOwner(c.service, staff);

  // Data access stops as soon as the profile is inactive (RLS checks it); the ban ends sessions.
  if (staff.active) {
    const { error } = await c.service.from('staff_profiles').update({ active: false }).eq('user_id', userId);
    if (error) throw fromPgError(error, 'admin-staff');
    await audit(c, 'staff.deactivate', userId, { active: true }, { active: false });
  }
  await setBan(c, userId, BAN_FOREVER, "The account is deactivated, but signing them out failed. Try again.");
  return userId;
}

async function reactivate(c: Ctx): Promise<string> {
  const userId = requireUuid(c.body.user_id, 'user_id', 'Staff member not found.');
  const staff = await loadStaff(c.service, userId);
  await setBan(c, userId, 'none', "Couldn't reactivate the account. Try again.");
  if (!staff.active) {
    const { error } = await c.service.from('staff_profiles').update({ active: true }).eq('user_id', userId);
    if (error) throw fromPgError(error, 'admin-staff');
    await audit(c, 'staff.reactivate', userId, { active: false }, { active: true });
  }
  return userId;
}

async function resendInvite(c: Ctx): Promise<string> {
  const userId = requireUuid(c.body.user_id, 'user_id', 'Staff member not found.');
  const staff = await loadStaff(c.service, userId);
  if (!staff.active) throw new HttpError(409, 'Reactivate this account first.', 'inactive');

  const { data, error } = await c.service.auth.admin.getUserById(userId);
  if (error || !data?.user) throw notFound();
  const email = data.user.email ?? staff.email;
  const joined = Boolean(data.user.email_confirmed_at || data.user.last_sign_in_at);

  let method: 'invite' | 'recovery' = joined ? 'recovery' : 'invite';
  if (method === 'invite') {
    const { error: inviteError } = await c.service.auth.admin.inviteUserByEmail(email, {
      redirectTo: redirectTo(c.req),
      data: { full_name: staff.full_name },
    });
    if (inviteError) {
      if (!alreadyRegistered(inviteError)) throw authFailure(inviteError, "Couldn't send the invite. Try again.");
      method = 'recovery';
    }
  }
  if (method === 'recovery') {
    const { error: resetError } = await c.service.auth.resetPasswordForEmail(email, { redirectTo: redirectTo(c.req) });
    if (resetError) throw authFailure(resetError, "Couldn't send the email. Try again.");
  }
  await audit(c, 'staff.resend_invite', userId, null, { method });
  return userId;
}

async function updateProfile(c: Ctx): Promise<string> {
  const userId = requireUuid(c.body.user_id, 'user_id', 'Staff member not found.');
  const staff = await loadStaff(c.service, userId);
  const patch: { full_name?: string; phone?: string | null } = {};
  if (c.body.full_name !== undefined) patch.full_name = parseName(c.body.full_name);
  if (c.body.phone !== undefined && c.body.phone !== null) patch.phone = parsePhone(c.body.phone);
  else if (c.body.phone === null) patch.phone = null;

  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch) as Array<[keyof typeof patch, string | null]>) {
    if (staff[k] !== v) {
      before[k] = staff[k];
      after[k] = v;
    }
  }
  if (Object.keys(after).length === 0) return userId;

  const { error } = await c.service.from('staff_profiles').update(after).eq('user_id', userId);
  if (error) throw fromPgError(error, 'admin-staff');
  await audit(c, 'staff.update_profile', userId, before, after);
  return userId;
}

const ACTIONS: Record<string, (c: Ctx) => Promise<string>> = {
  invite,
  set_role: setRole,
  deactivate,
  reactivate,
  resend_invite: resendInvite,
  update_profile: updateProfile,
};

Deno.serve(
  handler('admin-staff', async (req) => {
    allowMethods(req, ['POST']);
    const user = await requireUser(req);
    requireRole(user, ['owner']);
    const body = await readJson(req);
    const action = str(body.action);
    if (!Object.hasOwn(ACTIONS, action)) throw new HttpError(400, 'Unknown action.', 'invalid_action');
    const userId = await ACTIONS[action]({ user, service: serviceClient(), req, body });
    return json({ ok: true, user_id: userId });
  }),
);
