// Customers (6.7) and privacy rights (10.3) — port of the customer functions in
// supabase/migrations/20261011000400_documents_customers.sql.
import { IDENTITY_METHODS } from '../../shared/constants.ts';
import type { Customer } from '../../src/types/db.ts';
import { isAdmin, isOwner, isOwnerOrManager, isStaffRole, type Ctx } from '../access/context.ts';
import { customerHasBookingToday, sql } from '../access/scope.ts';
import { writeAudit } from '../audit.ts';
import { all, nowIso, one, run } from '../db/connection.ts';
import { decodeRows } from '../db/registry.ts';
import { deleteRow, getRow, insertRow, updateRow, updateWhere } from '../db/write.ts';
import { fail } from '../errors.ts';
import { currentNoticeVersion } from '../settings.ts';
import { bool, oneOf, str } from './args.ts';
import { defineRpc } from './registry.ts';

const AADHAAR_METHODS = ['aadhaar_qr', 'aadhaar_original_seen'];

const isBlank = (v: string | null | undefined) => (v ?? '').trim() === '';

const customerNotFound = (): never => fail('Customer not found.', 'not_found', undefined, 404);

// ------------------------------------------------------------------ identity (AAD-02, AAD-04)
// Record how identity was checked at pickup. Only the last 4 Aadhaar digits are kept.
defineRpc('verify_customer_identity', 'user', (ctx, a) => {
  const customerId = str(a, 'p_customer');
  const method = oneOf(a, 'p_method', IDENTITY_METHODS);
  const last4 = str(a, 'p_aadhaar_last4')?.trim() || null;
  const consent = bool(a, 'p_consent');
  const bookingId = str(a, 'p_booking');

  if (
    !isAdmin(ctx) ||
    !customerId ||
    !one('SELECT 1 FROM customers WHERE id = ? AND erased_at IS NULL', customerId) ||
    (isStaffRole(ctx) && !customerHasBookingToday(customerId))
  ) {
    return customerNotFound();
  }
  if (!method) fail('Choose how you verified their identity.', 'method');
  if (last4 !== null && !/^[0-9]{4}$/.test(last4)) fail('Enter only the last 4 digits of the Aadhaar number.', 'aadhaar_last4');

  const aadhaar = AADHAAR_METHODS.includes(method);
  if (aadhaar) {
    if (last4 === null) fail('Enter the last 4 digits of the Aadhaar number.', 'aadhaar_last4');
    if (!consent) fail('The customer must agree before you verify their Aadhaar.', 'consent');
    insertRow(ctx, 'consents', {
      customer_id: customerId,
      booking_id: bookingId,
      purpose: 'aadhaar_verification',
      notice_version: currentNoticeVersion(),
      channel: 'admin',
      ip: ctx.ip,
      user_agent: ctx.ua?.slice(0, 400) ?? null,
      recorded_by: ctx.userId,
    });
  }
  const patch: Record<string, unknown> = {
    identity_verified: true,
    identity_method: method,
    identity_verified_by: ctx.userId,
    identity_verified_at: nowIso(),
  };
  if (aadhaar) patch.aadhaar_last4 = last4;
  updateRow(ctx, 'customers', customerId, patch);
  return null;
});

defineRpc('clear_customer_identity', 'user', (ctx, a) => {
  if (!isOwnerOrManager(ctx)) fail('Not allowed.', 'forbidden', undefined, 403);
  const customerId = str(a, 'p_customer');
  const reason = str(a, 'p_reason');
  if (isBlank(reason)) fail('Give a reason.', 'reason');
  if (customerId) {
    updateRow(ctx, 'customers', customerId, {
      identity_verified: false,
      identity_method: null,
      identity_verified_by: null,
      identity_verified_at: null,
    });
  }
  writeAudit(ctx, 'customer.identity_cleared', 'customers', customerId, null, { reason });
  return null;
});

// CUS-04 blocklist.
defineRpc('set_customer_block', 'user', (ctx, a) => {
  if (!isOwnerOrManager(ctx)) fail('Not allowed.', 'forbidden', undefined, 403);
  const customerId = str(a, 'p_customer');
  const blocked = bool(a, 'p_blocked');
  const reason = str(a, 'p_reason');
  if (blocked && isBlank(reason)) fail('Give a reason for blocking this customer.', 'reason');
  const updated = customerId
    ? updateRow(ctx, 'customers', customerId, { blocked, block_reason: blocked ? reason!.trim() : null })
    : undefined;
  if (!updated) customerNotFound();
  return null;
});

// ------------------------------------------------------------------ privacy rights (10.3)
// CUS-06 / DP-05: export everything held about a customer (no files, no document numbers).
defineRpc('export_customer_data', 'user', (ctx, a) => {
  if (!isOwnerOrManager(ctx)) fail('Not allowed.', 'forbidden', undefined, 403);
  const customerId = str(a, 'p_customer');
  const c = customerId ? getRow<Customer>('customers', customerId) : undefined;
  if (!c) return customerNotFound();
  const { notes: _notes, ...customer } = c;

  const out = {
    exported_at: nowIso(),
    customer,
    bookings: all(
      `SELECT b.booking_code AS code, b.status, car.display_name AS car, b.package, b.pickup_at, b.return_due_at,
              b.actual_pickup_at, b.actual_return_at, b.total_paise, b.paid_paise
         FROM bookings b JOIN cars car ON car.id = b.car_id
        WHERE b.customer_id = ?
        ORDER BY b.pickup_at`,
      c.id,
    ),
    payments: all(
      `SELECT b.booking_code AS booking, p.amount_paise, p.type, p.method, p.received_at
         FROM payments p JOIN bookings b ON b.id = p.booking_id
        WHERE b.customer_id = ?
        ORDER BY p.received_at`,
      c.id,
    ),
    documents: all(
      `SELECT dt.label AS type, d.status, d.created_at AS uploaded_at, d.expiry_date
         FROM documents d JOIN document_types dt ON dt.key = d.doc_type
        WHERE d.customer_id = ? AND d.deleted_at IS NULL
        ORDER BY d.created_at`,
      c.id,
    ),
    consents: decodeRows(
      'consents',
      all(
        `SELECT cs.purpose, cs.notice_version, cs.granted_at, cs.withdrawn_at
           FROM consents cs WHERE cs.customer_id = ? ORDER BY cs.granted_at`,
        c.id,
      ),
    ),
  };
  writeAudit(ctx, 'customer.export', 'customers', c.id, null, null);
  return out;
});

/** Reasons erasure must wait (DP-05): open bookings, unsettled money, holds. */
export function erasureBlockers(customerId: string): string[] {
  const has = (q: string) => Boolean(one(q, customerId));
  const out: string[] = [];
  if (has(`SELECT 1 FROM bookings WHERE customer_id = ? AND status IN ('requested', 'confirmed', 'active', 'returned')`)) {
    out.push('The customer has a booking that is still open.');
  }
  if (
    has(`SELECT 1 FROM bookings WHERE customer_id = ?
           AND (total_paise - paid_paise <> 0 OR deposit_received_paise - deposit_refunded_paise <> 0)
           AND status NOT IN ('rejected', 'cancelled')`)
  ) {
    out.push('A payment, refund or deposit is not settled.');
  }
  if (has(`SELECT 1 FROM bookings WHERE customer_id = ? AND on_hold = 1`)) out.push('A booking is on hold for a fine, claim or dispute.');
  if (has(`SELECT 1 FROM documents WHERE customer_id = ? AND legal_hold = 1`)) out.push('A document is on hold.');
  return out;
}

defineRpc('erasure_blockers', 'user', (_ctx, a) => erasureBlockers(str(a, 'p_customer') ?? ''));

/**
 * Erase a customer's personal data (DP-05). Booking and payment records stay for accounts, but
 * are no longer linked to a name or number. Files are erased by the retention purge job.
 */
export function eraseCustomer(ctx: Ctx, customerId: string, reason: string | null): { ok: true; documents_queued: number } {
  if (!isOwner(ctx)) fail('Only the Owner can erase customer data.', 'forbidden', undefined, 403);
  if (isBlank(reason)) fail('Give a reason.', 'reason');
  const blockers = erasureBlockers(customerId);
  if (blockers.length > 0) fail(blockers.join(' '), 'erasure_blocked', blockers);

  // Like ksr.skip_row_audit: the personal data being erased is not copied into the audit log;
  // one summary entry is written at the end.
  const now = nowIso();
  const docs = run(
    `UPDATE documents
        SET deleted_at = ?, deleted_by = ?, delete_reason = ?, retain_until = ?, updated_at = ?
      WHERE deleted_at IS NULL
        AND (customer_id = ? OR booking_id IN (SELECT id FROM bookings WHERE customer_id = ?))
        AND doc_type IN (SELECT key FROM document_types WHERE is_kyc = 1 OR key IN ('signature', 'pickup_photos', 'return_photos'))`,
    now,
    ctx.userId,
    `Customer erasure: ${reason!.trim()}`,
    now,
    now,
    customerId,
    customerId,
  ).changes;

  updateRow(
    ctx,
    'customers',
    customerId,
    {
      full_name: 'Erased customer',
      phone: null,
      email: null,
      dl_number: null,
      dl_expiry: null,
      aadhaar_last4: null,
      identity_verified: false,
      identity_method: null,
      identity_verified_by: null,
      identity_verified_at: null,
      notes: '',
      erased_at: now,
    },
    { audit: false },
  );
  run(
    'UPDATE consents SET withdrawn_at = coalesce(withdrawn_at, ?), ip = NULL, user_agent = NULL, updated_at = ? WHERE customer_id = ?',
    now,
    now,
    customerId,
  );
  run('DELETE FROM upload_links WHERE customer_id = ?', customerId);

  writeAudit(ctx, 'customer.erase', 'customers', customerId, null, { reason, documents_queued_for_erasure: docs });
  return { ok: true, documents_queued: docs };
}

defineRpc('erase_customer', 'user', (ctx, a) => eraseCustomer(ctx, str(a, 'p_customer') ?? '', str(a, 'p_reason')));

// ------------------------------------------------------------------ merge (CUS-05)
// Merge two customer records, keeping all bookings and documents.
defineRpc('merge_customers', 'user', (ctx, a) => {
  if (!isOwner(ctx)) fail('Only the Owner can merge customers.', 'forbidden', undefined, 403);
  const keepId = str(a, 'p_keep');
  const mergeId = str(a, 'p_merge');
  const reason = str(a, 'p_reason');
  if (keepId !== null && keepId === mergeId) fail('Choose two different customers.', 'invalid');
  const k = keepId ? getRow<Customer>('customers', keepId) : undefined;
  const m = mergeId ? getRow<Customer>('customers', mergeId) : undefined;
  if (!k || !m) return customerNotFound();

  const now = nowIso();
  // Audited tables go through updateWhere (one entry per row, like the row triggers).
  updateWhere(ctx, 'bookings', sql('t.customer_id = ?', m.id), { customer_id: k.id });
  run('UPDATE documents SET customer_id = ?, updated_at = ? WHERE customer_id = ?', k.id, now, m.id);
  run('UPDATE consents SET customer_id = ?, updated_at = ? WHERE customer_id = ?', k.id, now, m.id);
  run('UPDATE upload_links SET customer_id = ?, updated_at = ? WHERE customer_id = ?', k.id, now, m.id);
  updateWhere(ctx, 'data_requests', sql('t.customer_id = ?', m.id), { customer_id: k.id });
  deleteRow(ctx, 'customers', m.id);

  // concat_ws skips blanks; "Merged with …" is dropped when there is no reason (null || text = null).
  const mergedNote = reason === null ? null : `Merged with ${m.phone ?? 'erased record'}: ${reason}`;
  updateRow(ctx, 'customers', k.id, {
    email: k.email ?? m.email,
    dl_number: k.dl_number ?? m.dl_number,
    dl_expiry: k.dl_expiry ?? m.dl_expiry,
    aadhaar_last4: k.aadhaar_last4 ?? m.aadhaar_last4,
    blocked: k.blocked || m.blocked,
    block_reason: k.block_reason ?? m.block_reason,
    notes: [k.notes || null, m.notes || null, mergedNote].filter((s) => s !== null).join('\n'),
  });
  writeAudit(ctx, 'customer.merge', 'customers', k.id, { merged_id: m.id, merged_phone: m.phone }, { reason });
  return null;
});
