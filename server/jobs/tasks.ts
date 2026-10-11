// Scheduled job bodies (9.3, 10.4, 11) — ports of mark_expired_documents, queue_expiry_reminders,
// queue_overdue_alerts, compute_document_retention and _purge_stale_records from
// supabase/migrations/20261011000400_documents_customers.sql. server/jobs/scheduler.ts calls
// these (each inside tx()).
import { addDaysIso, daysBetween, formatIsoDate, formatWhen, istDateIso, MS_DAY, MS_MINUTE } from '../../shared/time.ts';
import type { Ctx } from '../access/context.ts';
import { writeAudit } from '../audit.ts';
import { all, nowIso, run, scalar, tx, uuid } from '../db/connection.ts';
import { updateRow } from '../db/write.ts';
import { enqueueEmail, recipients } from '../outbox.ts';
import { bookingRule, retentionSetting } from '../settings.ts';

/** Days before expiry when vehicle-paper reminders go out (DOC-13); 0 = on the day. */
const REMINDER_DAYS = [30, 15, 7, 1, 0];

/** Booking statuses after which a booking is over (retention clock starts at ended_at). */
const ENDED_STATUSES = `('rejected', 'cancelled', 'no_show', 'closed')`;

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** DOC-12: pending/verified documents of expiry-tracking types past expiry → 'expired'. */
export function markExpiredDocuments(ctx: Ctx): number {
  const n = run(
    `UPDATE documents
        SET status = 'expired', updated_at = ?
      WHERE doc_type IN (SELECT key FROM document_types WHERE tracks_expiry = 1)
        AND deleted_at IS NULL
        AND status IN ('pending', 'verified')
        AND expiry_date < ?`,
    nowIso(),
    istDateIso(),
  ).changes;
  if (n > 0) writeAudit(ctx, 'documents.mark_expired', 'documents', null, null, { count: n });
  return n;
}

/** DOC-13: queue reminders 30/15/7/1/0 days before vehicle papers expire (deduplicated). */
export function queueExpiryReminders(_ctx: Ctx): number {
  const today = istDateIso();
  const dates = REMINDER_DAYS.map((d) => addDaysIso(today, d));
  const due = all<{ id: string; expiry_date: string; label: string; display_name: string; registration_number: string | null }>(
    `SELECT d.id, d.expiry_date, dt.label, c.display_name, c.registration_number
       FROM documents d
       JOIN document_types dt ON dt.key = d.doc_type
       JOIN cars c ON c.id = d.car_id
      WHERE d.owner_type = 'car'
        AND dt.tracks_expiry = 1
        AND d.deleted_at IS NULL
        AND d.status NOT IN ('superseded', 'rejected')
        AND d.expiry_date IN (${dates.map(() => '?').join(', ')})
      ORDER BY d.expiry_date, d.id`,
    ...dates,
  );
  if (!due.length) return 0;
  const to = recipients('expiry_emails');
  let n = 0;
  for (const r of due) {
    const daysLeft = daysBetween(today, r.expiry_date);
    const sent = scalar('SELECT 1 FROM document_reminders WHERE document_id = ? AND days_before = ?', r.id, daysLeft);
    if (sent) continue;
    const subject =
      daysLeft === 0
        ? `${r.label} expires today – ${r.display_name}`
        : `${r.label} expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'} – ${r.display_name}`;
    const body = [
      `${r.label} for ${r.display_name}${r.registration_number ? ` (${r.registration_number})` : ''} expires on ${formatIsoDate(r.expiry_date)}.`,
      "Upload the renewed document before it expires. Bookings for this car can't be confirmed with expired insurance, PUC or permit.",
    ].join('\n');
    enqueueEmail('expiry_reminder', to, subject, body, { document_id: r.id, path: `/admin/documents?doc=${r.id}` }, `expiry:${r.id}:${daysLeft}`);
    const now = nowIso();
    run(
      `INSERT INTO document_reminders (id, document_id, days_before, sent_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      uuid(),
      r.id,
      daysLeft,
      now,
      now,
      now,
    );
    n += 1;
  }
  return n;
}

/** Section 11: overdue return alerts (once per booking). */
export function queueOverdueAlerts(ctx: Ctx): number {
  const grace = Math.round(bookingRule('late_grace_minutes', 30));
  const due = all<{ id: string; booking_code: string; return_due_at: string; display_name: string; full_name: string; phone: string | null }>(
    `SELECT b.id, b.booking_code, b.return_due_at, c.display_name, cu.full_name, cu.phone
       FROM bookings b
       JOIN cars c ON c.id = b.car_id
       JOIN customers cu ON cu.id = b.customer_id
      WHERE b.status = 'active'
        AND b.return_due_at < ?
        AND b.overdue_notified_at IS NULL
      ORDER BY b.return_due_at`,
    ago(grace * MS_MINUTE),
  );
  let n = 0;
  for (const r of due) {
    enqueueEmail(
      'overdue',
      recipients('overdue_emails'),
      `Overdue return ${r.booking_code} – ${r.display_name}`,
      [`${r.display_name} (${r.booking_code}) was due back at ${formatWhen(r.return_due_at)}.`, `Customer: ${r.full_name}, ${r.phone ?? ''}`].join('\n'),
      { booking_code: r.booking_code, path: `/admin/bookings/${r.booking_code}` },
      `overdue:${r.id}`,
    );
    updateRow(ctx, 'bookings', r.id, { overdue_notified_at: nowIso() });
    n += 1;
  }
  return n;
}

/** 10.4: set documents.retain_until from each type's retention rule. */
export function computeDocumentRetention(_ctx: Ctx): number {
  const rows = all<{
    id: string;
    retain_until: string | null;
    created_at: string;
    retention_days: number | null;
    retention_basis: string;
    booking_ended_at: string | null;
    customer_open: number;
    customer_last_end: string | null;
  }>(
    `SELECT d.id, d.retain_until, d.created_at, t.retention_days, t.retention_basis,
            (SELECT b.ended_at FROM bookings b WHERE b.id = d.booking_id AND b.status IN ${ENDED_STATUSES}) AS booking_ended_at,
            EXISTS (SELECT 1 FROM bookings b WHERE b.customer_id = d.customer_id AND b.status NOT IN ${ENDED_STATUSES}) AS customer_open,
            (SELECT max(b.ended_at) FROM bookings b WHERE b.customer_id = d.customer_id) AS customer_last_end
       FROM documents d
       JOIN document_types t ON t.key = d.doc_type
      WHERE d.deleted_at IS NULL`,
  );
  const plus = (iso: string | null, days: number) => (iso ? new Date(Date.parse(iso) + days * MS_DAY).toISOString() : null);
  const now = nowIso();
  let n = 0;
  for (const r of rows) {
    let until: string | null = null;
    if (r.retention_days !== null && r.retention_basis !== 'none') {
      if (r.retention_basis === 'booking_end') {
        // Kept for N days after the booking ends.
        until = plus(r.booking_ended_at, r.retention_days);
      } else if (r.retention_basis === 'customer_last_booking_end' && !r.customer_open) {
        // Kept while the customer has an open booking, then N days after their last one ended.
        until = plus(r.customer_last_end ?? r.created_at, r.retention_days);
      }
    }
    if (until !== r.retain_until) {
      run('UPDATE documents SET retain_until = ?, updated_at = ? WHERE id = ?', until, now, r.id);
      n += 1;
    }
  }
  return n;
}

/** 10.4: erase stale requests, orphan customers, old audit entries and system rows. */
export function purgeStaleRecords(ctx: Ctx): Record<string, number> {
  const requestsDays = retentionSetting('requests_days', 90);
  // Audit entries outlive every document they describe (incl. the soft-delete grace period).
  const longestDocDays = scalar<number | null>('SELECT max(retention_days) FROM document_types') ?? 0;
  const auditDays = Math.max(retentionSetting('audit_days', 365), longestDocDays + retentionSetting('soft_delete_days', 30));
  const requestsCutoff = ago(requestsDays * MS_DAY);

  // Like ksr.skip_row_audit: rows are removed with plain deletes (no per-row audit copies of
  // personal data); one summary entry is written at the end.
  const counts = tx(() => {
    run('DELETE FROM submission_attempts WHERE at < ?', ago(2 * MS_DAY));
    run('DELETE FROM login_attempts WHERE at < ?', ago(30 * MS_DAY));
    run('DELETE FROM account_locks WHERE locked_until < ?', ago(MS_DAY));
    run('DELETE FROM upload_links WHERE expires_at < ?', ago(7 * MS_DAY));
    run(`DELETE FROM outbox WHERE status IN ('sent', 'skipped') AND created_at < ?`, ago(30 * MS_DAY));

    // Unconfirmed, rejected and never-started cancelled requests with nothing attached.
    const requests = run(
      `DELETE FROM bookings
        WHERE (status IN ('requested', 'rejected') OR (status = 'cancelled' AND actual_pickup_at IS NULL))
          AND coalesce(ended_at, pickup_at, created_at) < ?
          AND on_hold = 0
          AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = bookings.id)
          AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.booking_id = bookings.id)
          AND NOT EXISTS (SELECT 1 FROM booking_charges ch WHERE ch.booking_id = bookings.id)`,
      requestsCutoff,
    ).changes;

    // Customers left with nothing: no bookings, documents or open privacy requests.
    const customers = run(
      `DELETE FROM customers
        WHERE blocked = 0
          AND created_at < ?
          AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.customer_id = customers.id)
          AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.customer_id = customers.id)
          AND NOT EXISTS (SELECT 1 FROM data_requests r WHERE r.customer_id = customers.id AND r.status IN ('open', 'in_progress'))`,
      requestsCutoff,
    ).changes;

    // The audit_logs delete trigger allows deletes only while the audit_purge flag is set,
    // and only inside this transaction (replaces set_config('ksr.audit_purge', 'on', true)).
    run(`INSERT OR IGNORE INTO _flags (key) VALUES ('audit_purge')`);
    const audit = run('DELETE FROM audit_logs WHERE at < ?', ago(auditDays * MS_DAY)).changes;
    run(`DELETE FROM _flags WHERE key = 'audit_purge'`);

    return { requests, customers, audit_entries: audit };
  });

  if (counts.requests + counts.customers + counts.audit_entries > 0) {
    writeAudit(ctx, 'retention.purge', 'system', null, null, counts);
  }
  return counts;
}
