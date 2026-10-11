// Email outbox (Section 11): business code queues messages here; server/notify.ts sends them.
import type { AppRole } from '../shared/constants.ts';
import type { NotificationSettings } from '../shared/settings.ts';
import { all, nowIso, one, uuid } from './db/connection.ts';
import { getSetting } from './settings.ts';

/** Recipients for a notification list; empty lists fall back to active staff with these roles. */
export function recipients(listKey: keyof NotificationSettings, fallbackRoles: AppRole[] = ['owner', 'manager']): string[] {
  const configured = (getSetting('notifications')[listKey] ?? []).filter(Boolean);
  if (configured.length) return configured;
  if (!fallbackRoles.length) return [];
  return all<{ email: string }>(
    `SELECT p.email FROM staff_profiles p JOIN user_roles r ON r.user_id = p.user_id
      WHERE p.active = 1 AND r.role IN (${fallbackRoles.map(() => '?').join(', ')})
      ORDER BY r.role, p.email`,
    ...fallbackRoles,
  ).map((r) => r.email);
}

/** Queue an email. Returns the outbox id, or null if a message with this dedupe key exists. */
export function enqueueEmail(
  kind: string,
  to: string[],
  subject: string,
  body: string,
  payload: Record<string, unknown> = {},
  dedupeKey: string | null = null,
): string | null {
  const unique = [...new Set(to.filter(Boolean))];
  const now = nowIso();
  const row = one<{ id: string }>(
    `INSERT INTO outbox (id, kind, channel, recipients, subject, body, payload, dedupe_key, status, created_at, updated_at)
     VALUES (?, ?, 'email', ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    uuid(),
    kind,
    JSON.stringify(unique),
    subject,
    body,
    JSON.stringify(payload),
    dedupeKey,
    unique.length ? 'pending' : 'skipped',
    now,
    now,
  );
  return row?.id ?? null;
}
