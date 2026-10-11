// Scheduled job bodies (9.3, 10.4, 11) — ports of mark_expired_documents, queue_expiry_reminders,
// queue_overdue_alerts, compute_document_retention and _purge_stale_records.
// CONTRACT STUB: implement; server/jobs/scheduler.ts calls these (each inside tx()).
import type { Ctx } from '../access/context.ts';

/** DOC-12: pending/verified documents of expiry-tracking types past expiry → 'expired'. */
export function markExpiredDocuments(_ctx: Ctx): number {
  throw new Error('not implemented');
}

/** DOC-13: queue reminders 30/15/7/1/0 days before vehicle papers expire (deduplicated). */
export function queueExpiryReminders(_ctx: Ctx): number {
  throw new Error('not implemented');
}

/** Section 11: overdue return alerts (once per booking). */
export function queueOverdueAlerts(_ctx: Ctx): number {
  throw new Error('not implemented');
}

/** 10.4: set documents.retain_until from each type's retention rule. */
export function computeDocumentRetention(_ctx: Ctx): number {
  throw new Error('not implemented');
}

/** 10.4: erase stale requests, orphan customers, old audit entries and system rows. */
export function purgeStaleRecords(_ctx: Ctx): Record<string, number> {
  throw new Error('not implemented');
}
