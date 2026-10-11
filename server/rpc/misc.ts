// Account and audit RPCs: my_access, log_client_event, current_notice_version.
import { mfaRequired, type Ctx } from '../access/context.ts';
import { writeAudit } from '../audit.ts';
import { one } from '../db/connection.ts';
import { forbidden, fail } from '../errors.ts';
import { currentNoticeVersion, getSetting } from '../settings.ts';
import { json, str } from './args.ts';
import { defineRpc } from './registry.ts';

/** What the admin UI needs to route the user: role, whether two-step is required, current level. */
export function myAccess(ctx: Ctx) {
  const profile = ctx.userId
    ? one<{ full_name: string; active: number }>('SELECT full_name, active FROM staff_profiles WHERE user_id = ?', ctx.userId)
    : undefined;
  return {
    user_id: ctx.userId,
    role: ctx.roleRaw,
    effective_role: ctx.role,
    mfa_required: ctx.roleRaw ? mfaRequired(ctx.roleRaw) : false,
    aal: ctx.aal,
    full_name: profile?.full_name ?? null,
    active: profile?.active === 1,
    security: getSetting('security'),
  };
}

defineRpc('my_access', 'user', (ctx) => myAccess(ctx));

const CLIENT_EVENTS = new Set([
  'auth.logout',
  'auth.mfa_verified',
  'auth.mfa_enrolled',
  'auth.session_timeout',
  'report.export',
  'bookings.export',
  'payments.export',
  'documents.bulk_download',
  'booking.print',
]);

// Events the browser logs itself (exports, sign-out, bulk downloads).
defineRpc('log_client_event', 'user', (ctx, a) => {
  if (!ctx.roleRaw) forbidden();
  const action = str(a, 'p_action') ?? '';
  if (!CLIENT_EVENTS.has(action)) fail('Unknown audit action.', 'invalid');
  writeAudit(ctx, action, str(a, 'p_entity_type') ?? 'app', str(a, 'p_entity_id'), null, json(a, 'p_meta', null));
  return null;
});

defineRpc('current_notice_version', 'public', (_ctx, a) => currentNoticeVersion(str(a, 'p_locale') ?? 'en'));
