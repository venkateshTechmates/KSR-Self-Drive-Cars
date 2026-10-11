// Document centre, customers, privacy rights and retention jobs (6.7, 6.8, 10.3, 10.4) on the
// SQLite server. Ports AC-03, AC-10 (documents) and AC-12 from tests/db/rules.test.ts, plus
// checks for versioning, verification, soft delete, erasure and the scheduled jobs.
import { beforeEach, describe, expect, it } from 'vitest';
import { addDaysIso, formatIsoDate, istDateIso, istStartOfDay, MS_DAY, MS_HOUR } from '../../shared/time.ts';
import type { Ctx } from '../../server/access/context.ts';
import { canDownloadDocument, canViewDocument } from '../../server/access/scope.ts';
import { all, nowIso, one, run, scalar, tx, uuid } from '../../server/db/connection.ts';
import { ApiError } from '../../server/errors.ts';
import {
  computeDocumentRetention,
  markExpiredDocuments,
  purgeStaleRecords,
  queueExpiryReminders,
  queueOverdueAlerts,
} from '../../server/jobs/tasks.ts';
import '../../server/rpc/customers.ts';
import {
  documentAccess,
  documentDuplicates,
  eraseDocumentRow,
  logDocumentAccess,
  registerDocument,
  retentionDue,
  type RegisterDocumentInput,
} from '../../server/rpc/documents.ts';
import { getRpc } from '../../server/rpc/registry.ts';
import type { DocumentRow } from '../../src/types/db.ts';
import { addStaff, carId, createTestDb, system, type TestUser } from './harness.ts';

let owner: TestUser;
let manager: TestUser;
let staff: TestUser;
let seq = 0;

beforeEach(() => {
  createTestDb();
  owner = addStaff('owner');
  manager = addStaff('manager');
  staff = addStaff('staff');
});

// ------------------------------------------------------------------ helpers
const at = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
const daysAgo = (days: number) => at(-days * MS_DAY);
/** An instant early today (IST), so "booking today" holds whatever the time of day. */
const earlyToday = () => new Date(istStartOfDay(istDateIso()).getTime() + 60_000).toISOString();

/** Call an RPC the way the HTTP route does: inside one transaction. */
function call<T = unknown>(name: string, ctx: Ctx, args: Record<string, unknown>): T {
  const rpc = getRpc(name);
  if (!rpc) throw new Error(`No RPC ${name}`);
  return tx(() => rpc.handler(ctx, args)) as T;
}

function apiError(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('Expected an error');
}

function addCustomer(opts: { createdAt?: string; blocked?: boolean } = {}): string {
  seq += 1;
  const id = uuid();
  run(
    `INSERT INTO customers (id, full_name, phone, email, dl_number, blocked, block_reason, notes, created_at, updated_at)
     VALUES (?, 'Sita Devi', ?, 'sita@example.com', 'AP0920150001234', ?, ?, 'Prefers mornings', ?, ?)`,
    id,
    `+9198765${String(10000 + seq).slice(-5)}`,
    opts.blocked ? 1 : 0,
    opts.blocked ? 'Unpaid challan' : null,
    opts.createdAt ?? nowIso(),
    opts.createdAt ?? nowIso(),
  );
  return id;
}

function addBooking(
  customerId: string,
  slug: string,
  opts: { pickupAt?: string; hours?: number; status?: string; endedAt?: string; createdAt?: string; onHold?: boolean } = {},
): string {
  seq += 1;
  const id = uuid();
  const pickup = opts.pickupAt ?? at(MS_HOUR);
  const due = new Date(Date.parse(pickup) + (opts.hours ?? 12) * MS_HOUR).toISOString();
  run(
    `INSERT INTO bookings (id, booking_code, customer_id, car_id, package, pickup_at, return_due_at, hold_until, status,
       price_quoted_paise, ended_at, on_hold, hold_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, '12h', ?, ?, ?, ?, 150000, ?, ?, ?, ?, ?)`,
    id,
    `KSR-261011-${String(seq).padStart(3, '0')}`,
    customerId,
    carId(slug),
    pickup,
    due,
    due,
    opts.status ?? 'confirmed',
    opts.endedAt ?? null,
    opts.onHold ? 1 : 0,
    opts.onHold ? 'Open claim' : null,
    opts.createdAt ?? nowIso(),
    opts.createdAt ?? nowIso(),
  );
  return id;
}

function addDocument(o: {
  docType: string;
  customerId?: string;
  bookingId?: string;
  carId?: string;
  status?: string;
  expiryDate?: string | null;
  retainUntil?: string | null;
  legalHold?: boolean;
}): string {
  const id = uuid();
  const ownerType = o.carId ? 'car' : o.bookingId && !o.customerId ? 'booking' : 'customer';
  run(
    `INSERT INTO documents (id, owner_type, customer_id, booking_id, car_id, doc_type, storage_path, original_filename, mime_type,
       size_bytes, sha256, status, expiry_date, retain_until, aadhaar_masked_confirmed, legal_hold, hold_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'file.jpg', 'image/jpeg', 1000, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    ownerType,
    o.customerId ?? null,
    o.bookingId ?? null,
    o.carId ?? null,
    o.docType,
    `test/${id}.jpg`,
    'e'.repeat(64),
    o.status ?? 'pending',
    o.expiryDate ?? null,
    o.retainUntil ?? null,
    o.docType === 'aadhaar_masked' ? 1 : 0,
    o.legalHold ? 1 : 0,
    o.legalHold ? 'Open claim' : null,
  );
  return id;
}

function upload(ctx: Ctx, input: Partial<RegisterDocumentInput> & Pick<RegisterDocumentInput, 'ownerType' | 'ownerId' | 'docType'>): DocumentRow {
  const id = uuid();
  return tx(() =>
    registerDocument(ctx, {
      actorId: ctx.userId,
      storagePath: `docs/${id}.jpg`,
      originalFilename: 'licence.jpg',
      mime: 'image/jpeg',
      size: 2000,
      sha256: 'b'.repeat(64),
      uploadedVia: 'admin',
      ...input,
    }),
  );
}

const doc = (id: string) => one<Record<string, unknown>>('SELECT * FROM documents WHERE id = ?', id);
const auditRows = (action: string, entityId?: string) =>
  all<{ actor_id: string | null; ip: string | null; before: string | null; after: string | null }>(
    `SELECT actor_id, ip, before, after FROM audit_logs WHERE action = ? AND (? IS NULL OR entity_id = ?) ORDER BY at`,
    action,
    entityId ?? null,
    entityId ?? null,
  );

// ------------------------------------------------------------------ AC-03
describe('AC-03 no full Aadhaar', () => {
  it('has no column that can hold a full Aadhaar number', () => {
    const tables = all<{ name: string }>(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`);
    const cols = tables.flatMap((t) =>
      all<{ name: string }>(`PRAGMA table_info("${t.name}")`)
        .filter((c) => c.name.toLowerCase().includes('aadhaar'))
        .map((c) => `${t.name}.${c.name}`),
    );
    expect(cols.sort()).toEqual(['customers.aadhaar_last4', 'documents.aadhaar_masked_confirmed']);
    const c = addCustomer();
    expect(() => run(`UPDATE customers SET aadhaar_last4 = '123412341234' WHERE id = ?`, c)).toThrow(/CHECK/);
  });

  it('refuses unmasked Aadhaar uploads and 12-digit numbers', () => {
    const c = addCustomer();
    const unconfirmed = apiError(() => upload(manager.ctx(), { ownerType: 'customer', ownerId: c, docType: 'aadhaar_masked' }));
    expect(unconfirmed.detail).toBe('aadhaar_mask');
    const number = apiError(() =>
      upload(manager.ctx(), {
        ownerType: 'customer',
        ownerId: c,
        docType: 'aadhaar_masked',
        aadhaarMaskedConfirmed: true,
        docNumber: '1234 5678 9012',
      }),
    );
    expect(number).toMatchObject({ detail: 'doc_number', message: "Don't enter a full Aadhaar number. Leave the number blank." });
    addBooking(c, 'kia-sonet', { pickupAt: earlyToday() });
    const last4 = apiError(() =>
      call('verify_customer_identity', staff.ctx(), { p_customer: c, p_method: 'aadhaar_qr', p_aadhaar_last4: '123456789012', p_consent: true }),
    );
    expect(last4.detail).toBe('aadhaar_last4');
  });
});

// ------------------------------------------------------------------ AC-10 (documents)
describe('AC-10 staff document visibility', () => {
  it("hides KYC documents of customers whose booking isn't today", () => {
    const later = addCustomer();
    addBooking(later, 'maruti-ertiga', { pickupAt: at(5 * MS_DAY), status: 'requested' });
    const dl = addDocument({ customerId: later, docType: 'dl_front' });
    expect(canViewDocument(staff.ctx(), dl)).toBe(false);
    expect(documentAccess(staff.ctx(), dl)).toEqual({ can_view: false, can_download: false });
    expect(apiError(() => call('verify_document', staff.ctx(), { p_doc: dl, p_status: 'verified', p_method: 'original_seen' })).detail).toBe(
      'not_found',
    );
    expect(canViewDocument(manager.ctx(), dl)).toBe(true);
  });

  it("lets staff view but not download today's customer's licence", () => {
    const today = addCustomer();
    addBooking(today, 'tata-nexon-old', { pickupAt: earlyToday() });
    const dl = addDocument({ customerId: today, docType: 'dl_front' });
    expect(canViewDocument(staff.ctx(), dl)).toBe(true);
    expect(canDownloadDocument(staff.ctx(), dl)).toBe(false);
    expect(documentAccess(staff.ctx(), dl)).toMatchObject({ can_view: true, can_download: false, is_kyc: true, deleted: false });
    expect(documentAccess(manager.ctx(), dl)).toMatchObject({ can_view: true, can_download: true });
    // Owner and Manager have no access until two-step verification (ADM-03).
    expect(documentAccess(manager.ctxAal1(), dl).can_view).toBe(false);

    tx(() => logDocumentAccess(staff.ctx(), dl, 'document.view'));
    const log = auditRows('document.view', dl);
    expect(log).toHaveLength(1);
    expect(log[0].actor_id).toBe(staff.id);
    expect(JSON.parse(log[0].after!)).toEqual({ doc_type: 'dl_front', owner_type: 'customer', owner_id: today });
  });

  it('limits duplicate lookups to visible documents', () => {
    const later = addCustomer();
    addBooking(later, 'maruti-ertiga', { pickupAt: at(5 * MS_DAY), status: 'requested' });
    const dl = addDocument({ customerId: later, docType: 'dl_front' });
    expect(documentDuplicates(manager.ctx(), 'E'.repeat(64)).map((d) => d.id)).toEqual([dl]);
    expect(documentDuplicates(staff.ctx(), 'e'.repeat(64))).toEqual([]);
  });
});

// ------------------------------------------------------------------ registration and versioning
describe('registering documents (DOC-10, DOC-11)', () => {
  it('versions replacements and refuses to replace an old version', () => {
    const c = addCustomer();
    const v1 = upload(manager.ctx(), { ownerType: 'customer', ownerId: c, docType: 'dl_front', docNumber: 'TS09 2011 0012345' });
    expect(v1).toMatchObject({ status: 'pending', version: 1, doc_number_masked: 'XXXXXXXXXXX2345', uploaded_by: manager.id, aadhaar_masked_confirmed: false });
    const up = auditRows('document.upload', v1.id);
    expect(up).toHaveLength(1);
    expect(up[0]).toMatchObject({ actor_id: manager.id, ip: '203.0.113.9' });

    const v2 = upload(manager.ctx(), { ownerType: 'customer', ownerId: c, docType: 'dl_front', replacesId: v1.id });
    expect(v2).toMatchObject({ version: 2, replaces_id: v1.id, status: 'pending' });
    expect(doc(v1.id)!.status).toBe('superseded');
    expect(JSON.parse(auditRows('document.replace', v2.id)[0].after!)).toMatchObject({ version: 2, replaces: v1.id });

    const again = apiError(() => upload(manager.ctx(), { ownerType: 'customer', ownerId: c, docType: 'dl_front', replacesId: v1.id }));
    expect(again).toMatchObject({ detail: 'replaces', message: "The document being replaced doesn't match." });
    const otherType = apiError(() => upload(manager.ctx(), { ownerType: 'customer', ownerId: c, docType: 'dl_back', replacesId: v2.id }));
    expect(otherType.detail).toBe('replaces');

    // A soft-deleted document can't be replaced either.
    call('soft_delete_document', owner.ctx(), { p_doc: v2.id, p_reason: 'Wrong customer' });
    expect(apiError(() => upload(manager.ctx(), { ownerType: 'customer', ownerId: c, docType: 'dl_front', replacesId: v2.id })).detail).toBe(
      'replaces',
    );
  });

  it('applies the type rules: owner, expiry and initial status', () => {
    const car = carId('kia-sonet');
    expect(apiError(() => upload(manager.ctx(), { ownerType: 'car', ownerId: car, docType: 'dl_front' })).detail).toBe('doc_type');
    expect(apiError(() => upload(manager.ctx(), { ownerType: 'customer', ownerId: null, docType: 'dl_front' })).detail).toBe('owner');
    expect(apiError(() => upload(manager.ctx(), { ownerType: 'car', ownerId: car, docType: 'insurance' })).message).toBe('Enter the expiry date.');
    const backwards = apiError(() =>
      upload(manager.ctx(), { ownerType: 'car', ownerId: car, docType: 'insurance', issueDate: istDateIso(), expiryDate: addDaysIso(istDateIso(), -1) }),
    );
    expect(backwards.message).toBe('The expiry date is before the issue date.');
    const lapsed = upload(manager.ctx(), { ownerType: 'car', ownerId: car, docType: 'insurance', expiryDate: addDaysIso(istDateIso(), -1) });
    expect(lapsed.status).toBe('expired');
    const rc = upload(manager.ctx(), { ownerType: 'car', ownerId: car, docType: 'rc' });
    expect(rc).toMatchObject({ status: 'verified', owner_id: car, car_id: car });
  });

  it('checks upload permission by role and scope', () => {
    const c = addCustomer();
    const can = (ctx: Ctx, ownerType: string, ownerId: string | null, docType: string) =>
      call<boolean>('can_upload_document', ctx, { p_owner_type: ownerType, p_owner_id: ownerId, p_doc_type: docType });
    expect(can(manager.ctx(), 'customer', c, 'dl_front')).toBe(true);
    expect(can(staff.ctx(), 'customer', c, 'dl_front')).toBe(false);
    addBooking(c, 'kia-sonet', { pickupAt: earlyToday() });
    expect(can(staff.ctx(), 'customer', c, 'dl_front')).toBe(true);
    expect(can(staff.ctx(), 'car', carId('kia-sonet'), 'insurance')).toBe(false);
    expect(can(manager.ctx(), 'car', carId('kia-sonet'), 'insurance')).toBe(true);
    expect(can(manager.ctx(), 'business', null, 'gst_registration')).toBe(false);
    expect(can(owner.ctx(), 'business', null, 'gst_registration')).toBe(true);
  });
});

// ------------------------------------------------------------------ verification and details
describe('verify_document', () => {
  it("verifying a licence front sets the customer's licence expiry and number", () => {
    const c = addCustomer();
    addBooking(c, 'maruti-suzuki-fronx', { pickupAt: earlyToday() });
    const dl = addDocument({ customerId: c, docType: 'dl_front' });
    const expiry = addDaysIso(istDateIso(), 400);

    expect(apiError(() => call('verify_document', staff.ctx(), { p_doc: dl, p_status: 'verified' })).detail).toBe('method');
    expect(apiError(() => call('verify_document', staff.ctx(), { p_doc: dl, p_status: 'verified', p_method: 'original_seen' })).message).toBe(
      'Enter the licence expiry date.',
    );
    const lapsed = apiError(() =>
      call('verify_document', staff.ctx(), {
        p_doc: dl,
        p_status: 'verified',
        p_method: 'original_seen',
        p_expiry_date: addDaysIso(istDateIso(), -1),
      }),
    );
    expect(lapsed.detail).toBe('expiry_date');

    const r = call<DocumentRow>('verify_document', staff.ctx(), {
      p_doc: dl,
      p_status: 'verified',
      p_method: 'original_seen',
      p_expiry_date: expiry,
      p_doc_number: 'ts09-2011-0012399',
    });
    expect(r).toMatchObject({ status: 'verified', verification_method: 'original_seen', verified_by: staff.id, expiry_date: expiry, legal_hold: false });
    expect(r.doc_number_masked).toBe('XXXXXXXXXXXXX2399');
    expect(one('SELECT dl_expiry, dl_number FROM customers WHERE id = ?', c)).toEqual({ dl_expiry: expiry, dl_number: 'TS0920110012399' });
    expect(auditRows('document.verify', dl)).toHaveLength(1);
  });

  it('needs a reason to reject, and only verifies current customer ID documents', () => {
    const c = addCustomer();
    const dl = addDocument({ customerId: c, docType: 'dl_back' });
    expect(apiError(() => call('verify_document', manager.ctx(), { p_doc: dl, p_status: 'rejected', p_reason: '  ' })).detail).toBe('reason');
    expect(apiError(() => call('verify_document', manager.ctx(), { p_doc: dl, p_status: 'pending' })).message).toBe(
      'Mark the document Verified or Rejected.',
    );
    const r = call<DocumentRow>('verify_document', manager.ctx(), { p_doc: dl, p_status: 'rejected', p_reason: ' Blurred ' });
    expect(r).toMatchObject({ status: 'rejected', reject_reason: 'Blurred', verification_method: null });

    const rc = addDocument({ carId: carId('kia-sonet'), docType: 'rc', status: 'verified' });
    expect(apiError(() => call('verify_document', manager.ctx(), { p_doc: rc, p_status: 'verified', p_method: 'original_seen' })).detail).toBe(
      'invalid',
    );
    const old = addDocument({ customerId: c, docType: 'dl_back', status: 'superseded' });
    expect(apiError(() => call('verify_document', manager.ctx(), { p_doc: old, p_status: 'rejected', p_reason: 'x' })).detail).toBe('state');
  });

  it('update_document_details moves documents in and out of Expired', () => {
    const car = carId('kia-sonet');
    const ins = addDocument({ carId: car, docType: 'insurance', status: 'verified', expiryDate: addDaysIso(istDateIso(), 10) });
    let r = call<DocumentRow>('update_document_details', manager.ctx(), { p_doc: ins, p_expiry_date: addDaysIso(istDateIso(), -2) });
    expect(r.status).toBe('expired');
    r = call<DocumentRow>('update_document_details', manager.ctx(), { p_doc: ins, p_expiry_date: addDaysIso(istDateIso(), 300), p_notes: 'Renewed' });
    expect(r).toMatchObject({ status: 'verified', notes: 'Renewed' });
    const entry = auditRows('document.update', ins)[1];
    expect(JSON.parse(entry.before!)).toMatchObject({ notes: '' });

    const c = addCustomer();
    const b = addBooking(c, 'kia-sonet', { pickupAt: earlyToday() });
    const sig = addDocument({ bookingId: b, docType: 'rental_agreement', status: 'verified' });
    expect(apiError(() => call('update_document_details', staff.ctx(), { p_doc: sig, p_notes: 'x' })).detail).toBe('forbidden');
  });
});

// ------------------------------------------------------------------ soft delete, restore, hold
describe('soft delete (DOC-15)', () => {
  it('only the Owner deletes; the file is kept for the grace period and can be restored', () => {
    const c = addCustomer();
    const dl = addDocument({ customerId: c, docType: 'dl_front' });
    expect(apiError(() => call('soft_delete_document', manager.ctx(), { p_doc: dl, p_reason: 'Duplicate' }))).toMatchObject({
      detail: 'forbidden',
      message: 'Only the Owner can delete documents.',
    });
    expect(apiError(() => call('soft_delete_document', owner.ctx(), { p_doc: dl, p_reason: ' ' })).detail).toBe('reason');

    const before = Date.now();
    expect(call('soft_delete_document', owner.ctx(), { p_doc: dl, p_reason: 'Duplicate' })).toBeNull();
    const d = doc(dl)!;
    expect(d).toMatchObject({ deleted_by: owner.id, delete_reason: 'Duplicate' });
    const retain = Date.parse(d.retain_until as string);
    expect(retain).toBeGreaterThanOrEqual(before + 30 * MS_DAY);
    expect(retain).toBeLessThanOrEqual(Date.now() + 30 * MS_DAY);
    expect(JSON.parse(auditRows('document.delete', dl)[0].after!)).toMatchObject({ reason: 'Duplicate', erase_after: d.retain_until });

    // Hidden from the Manager, still visible to the Owner.
    expect(canViewDocument(manager.ctx(), dl)).toBe(false);
    expect(documentAccess(owner.ctx(), dl)).toMatchObject({ can_view: true, deleted: true });
    expect(apiError(() => call('soft_delete_document', owner.ctx(), { p_doc: dl, p_reason: 'Again' })).detail).toBe('not_found');

    expect(apiError(() => call('restore_document', manager.ctx(), { p_doc: dl })).detail).toBe('forbidden');
    call('restore_document', owner.ctx(), { p_doc: dl });
    expect(doc(dl)).toMatchObject({ deleted_at: null, deleted_by: null, delete_reason: null, retain_until: null });
    expect(apiError(() => call('restore_document', owner.ctx(), { p_doc: dl })).message).toBe('Document not found, or already erased.');
  });

  it('legal holds need Owner or Manager and a reason', () => {
    const c = addCustomer();
    const dl = addDocument({ customerId: c, docType: 'dl_front' });
    expect(apiError(() => call('set_document_hold', staff.ctx(), { p_doc: dl, p_hold: true, p_reason: 'Claim' })).detail).toBe('forbidden');
    expect(apiError(() => call('set_document_hold', manager.ctx(), { p_doc: dl, p_hold: true })).detail).toBe('reason');
    call('set_document_hold', manager.ctx(), { p_doc: dl, p_hold: true, p_reason: ' Claim 42 ' });
    expect(doc(dl)).toMatchObject({ legal_hold: 1, hold_reason: 'Claim 42' });
    call('set_document_hold', manager.ctx(), { p_doc: dl, p_hold: false });
    expect(doc(dl)).toMatchObject({ legal_hold: 0, hold_reason: null });
    expect(auditRows('document.hold', dl)).toHaveLength(1);
    expect(auditRows('document.release', dl)).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ customers and privacy rights
describe('customer erasure (DP-05)', () => {
  it('is blocked while a booking is open and erases personal data once it is closed', () => {
    const c = addCustomer();
    const b = addBooking(c, 'hyundai-i20', { pickupAt: at(3 * MS_DAY) });
    const dl = addDocument({ customerId: c, docType: 'dl_front' });
    const sig = addDocument({ bookingId: b, docType: 'signature', status: 'verified' });
    const agreement = addDocument({ bookingId: b, docType: 'rental_agreement', status: 'verified' });
    run(
      `INSERT INTO consents (id, customer_id, booking_id, purpose, notice_version, ip, user_agent) VALUES (?, ?, ?, 'booking', 'privacy-en-v1', '203.0.113.5', 'Firefox')`,
      uuid(),
      c,
      b,
    );
    run(`INSERT INTO upload_links (id, customer_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`, uuid(), c, uuid(), at(MS_DAY));

    expect(call('erasure_blockers', manager.ctx(), { p_customer: c })).toEqual(['The customer has a booking that is still open.']);
    expect(apiError(() => call('erase_customer', manager.ctx(), { p_customer: c, p_reason: 'Asked' })).detail).toBe('forbidden');
    const blocked = apiError(() => call('erase_customer', owner.ctx(), { p_customer: c, p_reason: 'Asked' }));
    expect(blocked).toMatchObject({ detail: 'erasure_blocked', message: 'The customer has a booking that is still open.' });
    expect(blocked.hint).toEqual(['The customer has a booking that is still open.']);

    run(`UPDATE bookings SET status = 'closed', ended_at = ? WHERE id = ?`, nowIso(), b);
    expect(call('erase_customer', owner.ctx(), { p_customer: c, p_reason: 'Customer asked' })).toEqual({ ok: true, documents_queued: 2 });

    expect(one('SELECT full_name, phone, email, dl_number, notes, erased_at IS NOT NULL AS erased FROM customers WHERE id = ?', c)).toEqual({
      full_name: 'Erased customer',
      phone: null,
      email: null,
      dl_number: null,
      notes: '',
      erased: 1,
    });
    for (const id of [dl, sig]) {
      expect(doc(id)).toMatchObject({ deleted_by: owner.id, delete_reason: 'Customer erasure: Customer asked' });
      expect(doc(id)!.retain_until! <= nowIso()).toBe(true);
    }
    expect(doc(agreement)!.deleted_at).toBeNull();
    expect(one('SELECT ip, user_agent, withdrawn_at IS NOT NULL AS withdrawn FROM consents WHERE customer_id = ?', c)).toEqual({
      ip: null,
      user_agent: null,
      withdrawn: 1,
    });
    expect(scalar('SELECT count(*) FROM upload_links WHERE customer_id = ?', c)).toBe(0);

    // One summary entry; the erased values are not copied into the log.
    expect(JSON.parse(auditRows('customer.erase', c)[0].after!)).toEqual({ reason: 'Customer asked', documents_queued_for_erasure: 2 });
    expect(auditRows('customers.update', c)).toHaveLength(0);

    // The retention purge picks the files up straight away.
    const due = retentionDue(500);
    expect(due.filter((d) => d.id === dl || d.id === sig).map((d) => d.reason)).toEqual(['deleted', 'deleted']);
  });

  it('reports unsettled money and holds', () => {
    const c = addCustomer();
    const b = addBooking(c, 'kia-sonet', { pickupAt: daysAgo(10), status: 'closed', endedAt: daysAgo(9), onHold: true });
    run('UPDATE bookings SET total_paise = 150000, paid_paise = 100000 WHERE id = ?', b);
    addDocument({ customerId: c, docType: 'dl_front', legalHold: true });
    expect(call('erasure_blockers', owner.ctx(), { p_customer: c })).toEqual([
      'A payment, refund or deposit is not settled.',
      'A booking is on hold for a fine, claim or dispute.',
      'A document is on hold.',
    ]);
  });

  it('exports what is held without notes or files, and audits the export', () => {
    const c = addCustomer();
    addBooking(c, 'kia-sonet', { pickupAt: at(2 * MS_DAY), status: 'requested' });
    addDocument({ customerId: c, docType: 'dl_front' });
    expect(apiError(() => call('export_customer_data', staff.ctx(), { p_customer: c })).detail).toBe('forbidden');
    const out = call<{ customer: Record<string, unknown>; bookings: Array<Record<string, unknown>>; documents: Array<Record<string, unknown>> }>(
      'export_customer_data',
      manager.ctx(),
      { p_customer: c },
    );
    expect(out.customer).toMatchObject({ id: c, full_name: 'Sita Devi', blocked: false });
    expect(out.customer).not.toHaveProperty('notes');
    expect(out.bookings[0]).toMatchObject({ status: 'requested', car: 'Kia Sonet', package: '12h' });
    expect(out.documents[0]).toMatchObject({ type: 'Driving licence – front', status: 'pending' });
    expect(auditRows('customer.export', c)).toHaveLength(1);
    expect(apiError(() => call('export_customer_data', manager.ctx(), { p_customer: uuid() })).detail).toBe('not_found');
  });

  it('records identity checks with consent for Aadhaar, and merges duplicates', () => {
    const c = addCustomer();
    const b = addBooking(c, 'kia-sonet', { pickupAt: earlyToday() });
    expect(apiError(() => call('verify_customer_identity', staff.ctx(), { p_customer: c, p_method: 'aadhaar_qr', p_aadhaar_last4: '1234' })).detail).toBe(
      'consent',
    );
    call('verify_customer_identity', staff.ctx(), { p_customer: c, p_method: 'aadhaar_qr', p_aadhaar_last4: '1234', p_consent: true, p_booking: b });
    expect(one('SELECT identity_verified, identity_method, aadhaar_last4, identity_verified_by FROM customers WHERE id = ?', c)).toEqual({
      identity_verified: 1,
      identity_method: 'aadhaar_qr',
      aadhaar_last4: '1234',
      identity_verified_by: staff.id,
    });
    expect(one(`SELECT purpose, channel, recorded_by FROM consents WHERE customer_id = ?`, c)).toEqual({
      purpose: 'aadhaar_verification',
      channel: 'admin',
      recorded_by: staff.id,
    });

    const dup = addCustomer();
    const b2 = addBooking(dup, 'hyundai-i20', { pickupAt: at(4 * MS_DAY), status: 'requested' });
    expect(apiError(() => call('merge_customers', manager.ctx(), { p_keep: c, p_merge: dup, p_reason: 'Same person' })).detail).toBe('forbidden');
    call('merge_customers', owner.ctx(), { p_keep: c, p_merge: dup, p_reason: 'Same person' });
    expect(scalar('SELECT customer_id FROM bookings WHERE id = ?', b2)).toBe(c);
    expect(scalar('SELECT count(*) FROM customers WHERE id = ?', dup)).toBe(0);
    expect(scalar<string>('SELECT notes FROM customers WHERE id = ?', c)).toMatch(/Merged with \+91\d{10}: Same person$/);
    expect(auditRows('customer.merge', c)).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ AC-12
describe('AC-12 retention purge', () => {
  it('lists an expired masked Aadhaar for erasure and records the erasure', () => {
    const c = addCustomer();
    addBooking(c, 'hyundai-i20', { pickupAt: at(200 * MS_HOUR), status: 'requested' });
    const id = addDocument({ customerId: c, docType: 'aadhaar_masked', retainUntil: daysAgo(1) });
    expect(retentionDue(500).map((d) => d.id)).toContain(id);
    tx(() => eraseDocumentRow(system(), id, 'retention'));
    expect(doc(id)).toBeUndefined();
    const audit = auditRows('document.erase', id);
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0].after!)).toEqual({ doc_type: 'aadhaar_masked', owner_type: 'customer', owner_id: c, reason: 'retention' });
  });

  it('skips documents on hold', () => {
    const c = addCustomer();
    addBooking(c, 'hyundai-i20', { pickupAt: at(300 * MS_HOUR), status: 'requested' });
    const held = addDocument({ customerId: c, docType: 'aadhaar_masked', retainUntil: daysAgo(1), legalHold: true });
    const c2 = addCustomer();
    addBooking(c2, 'kia-sonet', { pickupAt: daysAgo(20), status: 'closed', endedAt: daysAgo(19), onHold: true });
    const bookingHeld = addDocument({ customerId: c2, docType: 'dl_front', retainUntil: daysAgo(1) });
    const due = retentionDue(500).map((d) => d.id);
    expect(due).not.toContain(held);
    expect(due).not.toContain(bookingHeld);
  });

  it('computes retain_until from the retention rules', () => {
    const closed = addCustomer();
    const ended = daysAgo(10);
    const b = addBooking(closed, 'kia-sonet', { pickupAt: daysAgo(11), status: 'closed', endedAt: ended });
    const dl = addDocument({ customerId: closed, docType: 'dl_front' });
    const photos = addDocument({ bookingId: b, docType: 'pickup_photos', status: 'verified' });
    const open = addCustomer();
    addBooking(open, 'hyundai-i20', { pickupAt: at(2 * MS_DAY) });
    const openDl = addDocument({ customerId: open, docType: 'dl_front' });

    expect(tx(() => computeDocumentRetention(system()))).toBe(2);
    const plus180 = new Date(Date.parse(ended) + 180 * MS_DAY).toISOString();
    expect(doc(dl)!.retain_until).toBe(plus180);
    expect(doc(photos)!.retain_until).toBe(plus180);
    expect(doc(openDl)!.retain_until).toBeNull();
    expect(tx(() => computeDocumentRetention(system()))).toBe(0);
  });
});

// ------------------------------------------------------------------ scheduled jobs
describe('scheduled jobs', () => {
  it('marks lapsed documents Expired', () => {
    const car = carId('kia-sonet');
    const ins = addDocument({ carId: car, docType: 'insurance', status: 'verified', expiryDate: addDaysIso(istDateIso(), -1) });
    const current = addDocument({ carId: car, docType: 'puc', status: 'verified', expiryDate: istDateIso() });
    const c = addCustomer();
    const back = addDocument({ customerId: c, docType: 'dl_back', expiryDate: addDaysIso(istDateIso(), -1) });
    expect(tx(() => markExpiredDocuments(system()))).toBe(1);
    expect(doc(ins)!.status).toBe('expired');
    expect(doc(current)!.status).toBe('verified');
    expect(doc(back)!.status).toBe('pending');
    expect(JSON.parse(auditRows('documents.mark_expired')[0].after!)).toEqual({ count: 1 });
    expect(tx(() => markExpiredDocuments(system()))).toBe(0);
  });

  it('queues vehicle paper reminders once per document and day count', () => {
    const car = carId('kia-sonet');
    const week = addDaysIso(istDateIso(), 7);
    const ins = addDocument({ carId: car, docType: 'insurance', status: 'verified', expiryDate: week });
    const puc = addDocument({ carId: carId('hyundai-i20'), docType: 'puc', status: 'verified', expiryDate: istDateIso() });
    addDocument({ carId: car, docType: 'permit', status: 'verified', expiryDate: addDaysIso(istDateIso(), 8) });
    addDocument({ carId: car, docType: 'fitness', status: 'superseded', expiryDate: week });

    expect(tx(() => queueExpiryReminders(system()))).toBe(2);
    expect(tx(() => queueExpiryReminders(system()))).toBe(0);

    const mail = all<{ subject: string; body: string; dedupe_key: string; recipients: string; status: string }>(
      `SELECT subject, body, dedupe_key, recipients, status FROM outbox WHERE kind = 'expiry_reminder' ORDER BY dedupe_key`,
    );
    expect(mail).toHaveLength(2);
    const insMail = mail.find((m) => m.dedupe_key === `expiry:${ins}:7`)!;
    expect(insMail.subject).toBe('Insurance policy expires in 7 days – Kia Sonet');
    expect(insMail.body).toBe(
      `Insurance policy for Kia Sonet expires on ${formatIsoDate(week)}.\n` +
        "Upload the renewed document before it expires. Bookings for this car can't be confirmed with expired insurance, PUC or permit.",
    );
    // No expiry list configured: falls back to active Owners and Managers (by role, then email).
    expect(JSON.parse(insMail.recipients)).toEqual([manager.email, owner.email]);
    expect(insMail.status).toBe('pending');
    expect(mail.find((m) => m.dedupe_key === `expiry:${puc}:0`)!.subject).toBe('PUC certificate expires today – Hyundai i20');
    expect(scalar('SELECT count(*) FROM document_reminders')).toBe(2);
  });

  it('alerts once per overdue booking after the grace period', () => {
    const c = addCustomer();
    const late = addBooking(c, 'kia-sonet', { pickupAt: at(-14 * MS_HOUR), status: 'active' });
    const c2 = addCustomer();
    addBooking(c2, 'hyundai-i20', { pickupAt: at(-12 * MS_HOUR - 10 * 60_000), status: 'active' });
    expect(tx(() => queueOverdueAlerts(system()))).toBe(1);
    expect(tx(() => queueOverdueAlerts(system()))).toBe(0);
    expect(scalar('SELECT overdue_notified_at IS NOT NULL FROM bookings WHERE id = ?', late)).toBe(1);
    const mail = one<{ subject: string; body: string }>(`SELECT subject, body FROM outbox WHERE dedupe_key = ?`, `overdue:${late}`)!;
    expect(mail.subject).toMatch(/^Overdue return KSR-\d{6}-\d{3} – Kia Sonet$/);
    expect(mail.body).toMatch(/^Kia Sonet \(KSR-\d{6}-\d{3}\) was due back at .+\.\nCustomer: Sita Devi, \+91\d{10}$/);
  });

  it('purges stale requests, orphan customers and old audit entries', () => {
    const old = daysAgo(200);
    const requester = addCustomer({ createdAt: old });
    const rejected = addBooking(requester, 'kia-sonet', { pickupAt: old, status: 'rejected', createdAt: old });
    const orphan = addCustomer({ createdAt: old });
    const blockedOrphan = addCustomer({ createdAt: old, blocked: true });
    const recent = addCustomer();
    const kept = addBooking(recent, 'kia-sonet', { pickupAt: at(2 * MS_DAY), status: 'requested' });
    const oldAudit = uuid();
    run(
      `INSERT INTO audit_logs (id, action, entity_type, at, created_at, updated_at) VALUES (?, 'test.old', 'system', ?, ?, ?)`,
      oldAudit,
      daysAgo(400),
      daysAgo(400),
      daysAgo(400),
    );
    run(`INSERT INTO audit_logs (id, action, entity_type) VALUES (?, 'test.recent', 'system')`, uuid());

    expect(tx(() => purgeStaleRecords(system()))).toEqual({ requests: 1, customers: 2, audit_entries: 1 });
    expect(scalar('SELECT count(*) FROM bookings WHERE id = ?', rejected)).toBe(0);
    expect(scalar('SELECT count(*) FROM bookings WHERE id = ?', kept)).toBe(1);
    expect(all<{ id: string }>('SELECT id FROM customers WHERE id IN (?, ?, ?, ?)', requester, orphan, blockedOrphan, recent).map((r) => r.id).sort()).toEqual(
      [blockedOrphan, recent].sort(),
    );
    expect(scalar('SELECT count(*) FROM audit_logs WHERE id = ?', oldAudit)).toBe(0);
    expect(scalar(`SELECT count(*) FROM audit_logs WHERE action = 'test.recent'`)).toBe(1);
    expect(JSON.parse(auditRows('retention.purge')[0].after!)).toEqual({ requests: 1, customers: 2, audit_entries: 1 });
    expect(scalar('SELECT count(*) FROM _flags')).toBe(0);

    // The audit log stays read-only outside the purge.
    expect(() => run('DELETE FROM audit_logs')).toThrow(/cannot be changed or deleted/);
    expect(() => run(`UPDATE audit_logs SET action = 'x'`)).toThrow(/cannot be changed or deleted/);
    expect(tx(() => purgeStaleRecords(system()))).toEqual({ requests: 0, customers: 0, audit_entries: 0 });
  });
});
