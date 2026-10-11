// Booking rules and PRD acceptance criteria (Section 14) on the SQLite server: the booking
// parts of tests/db/rules.test.ts, with each RPC called through the registry and wrapped in
// tx(), as POST /api/rpc/<name> does.
import { beforeAll, describe, expect, it } from 'vitest';
import { anonCtx, type Ctx } from '../../server/access/context.ts';
import { all, one, run, scalar, tx, uuid } from '../../server/db/connection.ts';
import { updateRow } from '../../server/db/write.ts';
import { ApiError } from '../../server/errors.ts';
import { createBooking, type CreateBookingResult } from '../../server/rpc/booking.ts';
import { getRpc } from '../../server/rpc/registry.ts';
import { addDaysIso, formatIsoDate, formatWhen, fromIst, istDateIso, weekdayOf } from '../../shared/time.ts';
import { addStaff, carId, createTestDb, visitor, type TestUser } from './harness.ts';

const HOUR = 3_600_000;

let owner: TestUser;
let manager: TestUser;
let staff: TestUser;
let phoneSeq = 0;
let codeSeq = 0;

const today = () => istDateIso();
const iso = (ms: number) => new Date(ms).toISOString();
const nextPhone = () => `98${String(76500000 + (phoneSeq += 1)).padStart(8, '0')}`;

type Created = Extract<CreateBookingResult, { ok: true }>;
type Row = Record<string, unknown>;

/** Call an RPC handler like the HTTP route does: inside one transaction. */
function rpc<T = unknown>(ctx: Ctx, name: string, args: Row = {}): T {
  const def = getRpc(name);
  if (!def) throw new Error(`RPC ${name} is not registered`);
  return tx(() => def.handler(ctx, args)) as T;
}

/** Expect the call to fail with an ApiError carrying this machine code (and message). */
function expectFail(fn: () => unknown, detail: string, message?: string | RegExp): ApiError {
  let error: unknown = null;
  try {
    fn();
  } catch (err) {
    error = err;
  }
  if (!(error instanceof ApiError)) throw new Error(`Expected an ApiError (${detail}), got ${String(error)}`);
  expect(error.detail).toBe(detail);
  if (typeof message === 'string') expect(error.message).toBe(message);
  else if (message) expect(error.message).toMatch(message);
  return error;
}

interface RequestOpts {
  phone?: string;
  reject?: boolean;
  name?: string;
  dl?: string;
  email?: string | null;
}

/** A website request, as the submit-booking route makes it. */
function websiteRequest(slug: string, pkg: '12h' | '24h', date: string, time: string, opts: RequestOpts = {}): CreateBookingResult {
  return tx(() =>
    createBooking(visitor(), {
      carId: carId(slug),
      package: pkg,
      pickupAt: fromIst(date, time)!.toISOString(),
      customHours: null,
      fullName: opts.name ?? 'Ravi Kumar',
      phone: opts.phone ?? nextPhone(),
      dlNumber: opts.dl ?? 'TS0920110012345',
      email: opts.email ?? null,
      source: 'website',
      createdBy: null,
      noticeVersion: 'privacy-en-v1',
      consentChannel: 'website',
      ip: '203.0.113.9',
      userAgent: 'vitest',
      rejectOnClash: opts.reject ?? true,
      staff: false,
    }),
  );
}

function websiteBooking(slug: string, pkg: '12h' | '24h', date: string, time: string, opts: RequestOpts = {}): Created {
  const r = websiteRequest(slug, pkg, date, time, opts);
  if (!r.ok) throw new Error(`Expected a booking, got: ${r.message}`);
  return r;
}

/** Insert a booking directly (bypasses the pickup rules), for "today" scenarios. */
function rawBooking(slug: string, pickupOffsetHours: number, status = 'confirmed') {
  const customerId = uuid();
  const bookingId = uuid();
  const phone = `+91${nextPhone()}`;
  const pickup = Date.now() + pickupOffsetHours * HOUR;
  run(`INSERT INTO customers (id, full_name, phone, dl_number) VALUES (?, 'Sita Devi', ?, 'AP0920150001234')`, customerId, phone);
  // Derived fields as bookings_derive would set them: 60 min buffer, total = price.
  run(
    `INSERT INTO bookings (id, booking_code, customer_id, car_id, package, pickup_at, return_due_at, hold_until, buffer_minutes,
       status, price_quoted_paise, total_paise)
     VALUES (?, ?, ?, ?, '12h', ?, ?, ?, 60, ?, 150000, 150000)`,
    bookingId,
    `KSR-000000-${String((codeSeq += 1)).padStart(3, '0')}`,
    customerId,
    carId(slug),
    iso(pickup),
    iso(pickup + 12 * HOUR),
    iso(pickup + 13 * HOUR),
    status,
  );
  return { bookingId, customerId, phone };
}

const transition = (user: TestUser, booking: string, to: string, note?: string, override?: string) =>
  rpc<{ ok: boolean; status: string }>(user.ctx(), 'booking_transition', {
    p_booking: booking,
    p_to: to,
    p_note: note ?? null,
    p_override_reason: override ?? null,
  });

const bookingRow = (id: string) => one<Row>('SELECT * FROM bookings WHERE id = ?', id)!;

const lastEvent = (bookingId: string, kind = 'status') =>
  all<Row>('SELECT * FROM booking_events WHERE booking_id = ? AND kind = ? ORDER BY at, rowid', bookingId, kind).at(-1)!;

function nextWeekday(day: 'sat' | 'wed', minDaysAhead = 1): string {
  let d = addDaysIso(today(), minDaysAhead);
  while (weekdayOf(d) !== day) d = addDaysIso(d, 1);
  return d;
}

/** A verified driving licence (what verify_document records). */
function addVerifiedLicence(customerId: string, expiry: string): string {
  const id = uuid();
  run(
    `INSERT INTO documents (id, owner_type, customer_id, doc_type, storage_path, original_filename, mime_type, size_bytes, sha256,
       status, verification_method, verified_at, expiry_date)
     VALUES (?, 'customer', ?, 'dl_front', ?, 'dl.jpg', 'image/jpeg', 2000, ?, 'verified', 'original_seen', ?, ?)`,
    id,
    customerId,
    `customers/${customerId}/dl_front/${id}.jpg`,
    'b'.repeat(64),
    new Date().toISOString(),
    expiry,
  );
  return id;
}

beforeAll(() => {
  createTestDb();
  owner = addStaff('owner');
  manager = addStaff('manager');
  staff = addStaff('staff');
});

describe('AC-01 complete request', () => {
  it('creates a Requested booking with a KSR code, the 24 hr price and the return time, and queues an email', () => {
    const tomorrow = addDaysIso(today(), 1);
    const r = websiteBooking('kia-sonet', '24h', tomorrow, '10:00');
    expect(r.booking_code).toMatch(/^KSR-\d{6}-\d{3}$/);
    expect(r.booking_code.slice(4, 10)).toBe(today().slice(2).replace(/-/g, ''));
    expect(r.price_paise).toBe(350000);
    expect(Date.parse(r.return_due_at) - Date.parse(r.pickup_at)).toBe(24 * HOUR);
    expect(r.pickup_at).toBe(fromIst(tomorrow, '10:00')!.toISOString());
    expect(r.flags).toEqual([]);
    expect(r.clashes).toEqual([]);

    const b = bookingRow(r.booking_id);
    expect(b).toMatchObject({ status: 'requested', source: 'website', buffer_minutes: 60, total_paise: 350000, payment_status: 'unpaid' });
    expect(b.hold_until).toBe(iso(Date.parse(r.return_due_at) + HOUR));
    expect(one('SELECT purpose, channel, notice_version, ip FROM consents WHERE id = ?', b.consent_id as string)).toEqual({
      purpose: 'booking',
      channel: 'website',
      notice_version: 'privacy-en-v1',
      ip: '203.0.113.9',
    });
    expect(lastEvent(r.booking_id)).toMatchObject({ to_status: 'requested', from_status: null, note: 'Request sent from the website' });

    const mail = one<{ kind: string; subject: string; body: string; recipients: string; status: string }>(
      `SELECT kind, subject, body, recipients, status FROM outbox WHERE json_extract(payload, '$.booking_code') = ?`,
      r.booking_code,
    )!;
    expect(mail.kind).toBe('new_request');
    expect(mail.subject).toBe(`New booking request ${r.booking_code} – Kia Sonet`);
    expect(mail.body).toContain('Package: 24 hrs');
    expect(mail.body).toContain('Price: ₹3,500');
    expect(mail.body).not.toContain('Flags:');
    // No notification list configured: falls back to the Owner and Managers.
    expect(JSON.parse(mail.recipients)).toEqual(expect.arrayContaining([owner.email, manager.email]));
    expect(mail.status).toBe('pending');
  });

  it('numbers codes sequentially per day', () => {
    const tomorrow = addDaysIso(today(), 1);
    const a = websiteBooking('toyota-glanza', '12h', tomorrow, '09:00');
    const b = websiteBooking('hyundai-i20', '12h', tomorrow, '09:00');
    expect(Number(b.booking_code.slice(-3))).toBe(Number(a.booking_code.slice(-3)) + 1);
  });

  it('matches repeat customers by mobile number and notes a different licence number', () => {
    const phone = nextPhone();
    const day = addDaysIso(today(), 2);
    const a = websiteBooking('maruti-baleno', '12h', day, '09:00', { phone });
    const b = websiteBooking('maruti-baleno', '12h', addDaysIso(day, 1), '09:00', {
      phone: `+91 ${phone}`,
      name: '  Ravi   K. Kumar ',
      dl: 'TS09 2011 0099999',
      email: 'Ravi@Example.com',
    });
    expect(b.customer_id).toBe(a.customer_id);
    expect(one('SELECT full_name, email, dl_number FROM customers WHERE id = ?', a.customer_id)).toEqual({
      full_name: 'Ravi K. Kumar',
      email: 'ravi@example.com',
      dl_number: 'TS0920110012345',
    });
    expect(bookingRow(b.booking_id).admin_notes).toBe('Licence number given for this booking: TS0920110099999 (differs from the one on file).');
  });

  it('rejects pickups outside opening hours, off the time step, too far ahead or in the past', () => {
    const tomorrow = addDaysIso(today(), 1);
    expectFail(() => websiteRequest('kia-sonet', '12h', tomorrow, '22:00'), 'pickup', /We hand over cars between 8:00 am and 8:00 pm/);
    expectFail(() => websiteRequest('kia-sonet', '12h', tomorrow, '10:15'), 'pickup', /30-minute step/);
    expectFail(() => websiteRequest('kia-sonet', '12h', addDaysIso(today(), 90), '10:00'), 'pickup', /up to 60 days/);
    expectFail(() => websiteRequest('kia-sonet', '12h', addDaysIso(today(), -1), '10:00'), 'pickup', 'Choose today or a later date.');
  });

  it('checks the customer details like the form does', () => {
    const tomorrow = addDaysIso(today(), 1);
    expectFail(() => websiteRequest('kia-sonet', '12h', tomorrow, '10:00', { phone: '12345' }), 'phone');
    expectFail(() => websiteRequest('kia-sonet', '12h', tomorrow, '10:00', { name: 'R2D2' }), 'full_name');
    expectFail(() => websiteRequest('kia-sonet', '12h', tomorrow, '10:00', { dl: 'AB12' }), 'dl_number');
    expectFail(() => websiteRequest('kia-sonet', '12h', tomorrow, '10:00', { email: 'ravi@example' }), 'email');
  });
});

describe('BKA-06 phone, walk-in and WhatsApp bookings', () => {
  const walkIn = (extra: Row = {}): Row => ({
    p_car_id: carId('tata-nexon-new'),
    p_package: '12h',
    // Off the 30-minute step: staff bookings skip the step and the notice period.
    p_pickup_at: fromIst(addDaysIso(today(), 1), '10:07')!.toISOString(),
    p_full_name: 'Anil Rao',
    p_phone: nextPhone(),
    p_dl_number: 'MH12 2009 1234',
    p_source: 'walk_in',
    p_consent_confirmed: true,
    ...extra,
  });

  it('needs Owner/Manager, a staff source, the consent box and reasons for price changes', () => {
    expectFail(() => rpc(staff.ctx(), 'admin_create_booking', walkIn()), 'forbidden', 'Not allowed.');
    expectFail(() => rpc(manager.ctx(), 'admin_create_booking', walkIn({ p_source: 'website' })), 'source');
    expectFail(() => rpc(manager.ctx(), 'admin_create_booking', walkIn({ p_consent_confirmed: false })), 'consent');
    expectFail(() => rpc(manager.ctx(), 'admin_create_booking', walkIn({ p_package: 'custom', p_custom_hours: 6 })), 'price');
    expectFail(() => rpc(manager.ctx(), 'admin_create_booking', walkIn({ p_price_override_paise: 100000 })), 'price_reason');
  });

  it('records a walk-in with a price override, licence-format flag and an admin consent', () => {
    const r = rpc<Created>(manager.ctx(), 'admin_create_booking', walkIn({ p_price_override_paise: 180000, p_override_reason: 'Regular customer' }));
    expect(r.ok).toBe(true);
    expect(r.price_paise).toBe(180000);
    expect(r.flags).toEqual(['dl_format']);
    expect(bookingRow(r.booking_id)).toMatchObject({ source: 'walk_in', created_by: manager.id, price_quoted_paise: 180000 });
    expect(lastEvent(r.booking_id)).toMatchObject({
      actor_id: manager.id,
      note: 'Created by staff (walk-in). Price set to ₹1,800: Regular customer',
    });
    expect(one('SELECT channel, recorded_by, notice_version FROM consents WHERE booking_id = ?', r.booking_id)).toEqual({
      channel: 'admin',
      recorded_by: manager.id,
      notice_version: 'privacy-en-v1',
    });
    const mail = one<{ body: string }>(`SELECT body FROM outbox WHERE json_extract(payload, '$.booking_code') = ?`, r.booking_code)!;
    expect(mail.body).toContain('Flags: dl_format');
    expect(mail.body).toContain('Source: walk_in');
  });
});

describe('AC-04 clash blocked', () => {
  let sat: string;
  let first: Created;
  let second: Created;

  it('refuses to confirm an overlapping booking and names the clashing one', () => {
    sat = nextWeekday('sat');
    first = websiteBooking('maruti-xl6-cng', '12h', sat, '09:00');
    expect(transition(manager, first.booking_id, 'confirmed')).toEqual({ ok: true, status: 'confirmed' });
    second = websiteBooking('maruti-xl6-cng', '12h', sat, '15:00', { reject: false });
    expect(second.flags).toContain('clash');
    expect(second.clashes.map((c) => c.booking_code)).toEqual([first.booking_code]);

    const holdUntil = bookingRow(first.booking_id).hold_until as string;
    const e = expectFail(
      () => transition(manager, second.booking_id, 'confirmed'),
      'clash',
      `This car is already booked: ${first.booking_code} (${formatWhen(first.pickup_at)} – ${formatWhen(holdUntil)}).`,
    );
    expect(e.hint).toEqual({ kind: 'booking', id: first.booking_id, code: first.booking_code, starts_at: first.pickup_at, ends_at: holdUntil });
  });

  it('website requests for a held car are refused with same-category suggestions', () => {
    const r = websiteRequest('maruti-xl6-cng', '12h', sat, '10:00', { reject: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('clash');
    expect(r.message).toBe('This car is booked at that time. Try another time or another car.');
    expect(r.suggestions.map((s) => s.slug)).toContain('maruti-ertiga');
    expect(JSON.stringify(r)).not.toContain(first.booking_code);
  });

  it('the overlap trigger stops overlaps even without the function checks', () => {
    expect(() => tx(() => run(`UPDATE bookings SET status = 'confirmed' WHERE id = ?`, second.booking_id))).toThrow(/bookings_no_overlap/);
    expect(bookingRow(second.booking_id).status).toBe('requested');
  });

  it('car_clashes shows signed-in staff what holds the car', () => {
    const args = { p_car: carId('maruti-xl6-cng'), p_start: fromIst(sat, '12:00')!.toISOString(), p_end: fromIst(sat, '13:00')!.toISOString() };
    expect(rpc(staff.ctx(), 'car_clashes', { ...args, p_exclude: null })).toEqual([
      {
        kind: 'booking',
        ref_id: first.booking_id,
        booking_code: first.booking_code,
        status: 'confirmed',
        starts_at: first.pickup_at,
        ends_at: bookingRow(first.booking_id).hold_until,
        note: null,
      },
    ]);
    expect(rpc(staff.ctx(), 'car_clashes', { ...args, p_exclude: first.booking_id })).toEqual([]);
    expectFail(() => rpc(visitor(), 'car_clashes', args), 'forbidden');
  });
});

describe('AC-05 expired papers', () => {
  it('blocks confirmation unless the Owner overrides with a reason, which is audited', () => {
    const punch = carId('tata-punch-cng');
    const yesterday = addDaysIso(today(), -1);
    run(
      `INSERT INTO documents (owner_type, car_id, doc_type, storage_path, original_filename, mime_type, size_bytes, sha256, expiry_date, status)
       VALUES ('car', ?, 'insurance', 'vehicles/x/insurance/a.pdf', 'ins.pdf', 'application/pdf', 1000, ?, ?, 'expired')`,
      punch,
      'a'.repeat(64),
      yesterday,
    );
    expect(rpc(manager.ctx(), 'car_paper_problems', { p_car: punch })).toEqual([
      { doc_type: 'insurance', label: 'Insurance policy', expiry_date: yesterday, problem: 'expired' },
      { doc_type: 'puc', label: 'PUC certificate', expiry_date: null, problem: 'missing' },
      { doc_type: 'permit', label: 'Permit / rent-a-cab authorisation', expiry_date: null, problem: 'missing' },
    ]);
    expectFail(() => rpc(staff.ctx(), 'car_paper_problems', { p_car: punch }), 'forbidden');

    const r = websiteBooking('tata-punch-cng', '12h', addDaysIso(today(), 3), '10:00');
    const e = expectFail(
      () => transition(manager, r.booking_id, 'confirmed'),
      'papers_expired',
      `Insurance policy for this car expires on ${formatIsoDate(yesterday)}, before the return time. The Owner can override with a reason.`,
    );
    expect(e.hint).toEqual({ doc_type: 'insurance', expiry_date: yesterday });
    // A Manager cannot override.
    expectFail(() => transition(manager, r.booking_id, 'confirmed', undefined, 'urgent'), 'papers_expired', /Owner can override/);

    expect(transition(owner, r.booking_id, 'confirmed', undefined, 'Renewal paid, certificate awaited')).toEqual({ ok: true, status: 'confirmed' });
    const audit = one<{ actor_id: string; after: string }>(
      `SELECT actor_id, after FROM audit_logs WHERE action = 'booking.override' AND entity_id = ?`,
      r.booking_id,
    )!;
    expect(audit.actor_id).toBe(owner.id);
    expect(JSON.parse(audit.after)).toMatchObject({ to: 'confirmed', reason: 'Renewal paid, certificate awaited' });
    const dd = formatIsoDate(yesterday).replace(/^(\d) /, '0$1 ');
    expect(lastEvent(r.booking_id, 'override').note).toBe(`Insurance policy expired ${dd}. Reason: Renewal paid, certificate awaited`);
  });
});

describe('AC-09 pickup gate', () => {
  it('requires a verified licence valid past the return time and verified identity', () => {
    const { bookingId, customerId } = rawBooking('maruti-suzuki-fronx', 1);
    const pickup = { p_booking: bookingId, p_kind: 'pickup', p_odometer_km: 12000, p_fuel_level: 'full' };
    const identity = "Verify the customer's identity (Aadhaar QR, passport or voter ID).";
    const e = expectFail(() => rpc(staff.ctx(), 'record_handover', pickup), 'pickup_gate', /Verify the driving licence/);
    expect(e.hint).toEqual(['Verify the driving licence (front photo) first.', 'Record the licence expiry date when verifying the licence.', identity]);

    // A verified licence that ran out yesterday.
    const yesterday = addDaysIso(today(), -1);
    const licence = addVerifiedLicence(customerId, yesterday);
    expect(rpc(staff.ctx(), 'pickup_gate_problems', { p_booking: bookingId })).toEqual([
      `The driving licence expires on ${formatIsoDate(yesterday)}, before the return time.`,
      identity,
    ]);

    // Renewed licence, and identity checked (what verify_document / verify_customer_identity record).
    const renewed = addDaysIso(today(), 400);
    run('UPDATE documents SET expiry_date = ? WHERE id = ?', renewed, licence);
    run(
      `UPDATE customers SET dl_expiry = ?, identity_verified = 1, identity_method = 'aadhaar_qr', aadhaar_last4 = '1234',
         identity_verified_by = ?, identity_verified_at = ? WHERE id = ?`,
      renewed,
      staff.id,
      new Date().toISOString(),
      customerId,
    );
    expect(rpc(staff.ctx(), 'pickup_gate_problems', { p_booking: bookingId })).toEqual([]);

    expect(rpc(staff.ctx(), 'record_handover', pickup)).toEqual({ ok: true, status: 'active' });
    expect(bookingRow(bookingId)).toMatchObject({ status: 'active' });
    expect(bookingRow(bookingId).actual_pickup_at).not.toBeNull();
    expect(lastEvent(bookingId).note).toBe('Picked up. Odometer 12000 km, fuel full.');

    // Return computes km and lateness.
    expectFail(
      () => rpc(staff.ctx(), 'record_handover', { p_booking: bookingId, p_kind: 'return', p_odometer_km: 11999, p_fuel_level: 'half' }),
      'odometer_km',
      'The odometer reading is lower than at pickup (12000 km).',
    );
    const ret = rpc(staff.ctx(), 'record_handover', { p_booking: bookingId, p_kind: 'return', p_odometer_km: 12250, p_fuel_level: 'half' });
    expect(ret).toEqual({
      ok: true,
      status: 'returned',
      km_driven: 250,
      fuel_diff_quarters: -2,
      late_hours: 0,
      suggested_late_fee_paise: 0,
      extra_km: 0,
      suggested_km_charge_paise: 0,
      deposit_held_paise: 0,
    });
    expect(lastEvent(bookingId).note).toBe('Returned. Odometer 12250 km (250 km driven), fuel half.');
    expect(all('SELECT kind FROM handover_records WHERE booking_id = ? ORDER BY kind', bookingId)).toEqual([{ kind: 'pickup' }, { kind: 'return' }]);
  });

  it('lets only the Owner override the gate; the return summary suggests late and km charges', () => {
    // Due back 3 hours ago: 2.5 hours past the 30-minute grace period.
    const { bookingId } = rawBooking('hyundai-i20', -15);
    const pickup = { p_booking: bookingId, p_kind: 'pickup', p_odometer_km: 5000, p_fuel_level: 'full', p_override_reason: 'Known customer' };
    expectFail(() => rpc(manager.ctx(), 'record_handover', pickup), 'pickup_gate');
    expect(rpc(owner.ctx(), 'record_handover', pickup)).toEqual({ ok: true, status: 'active' });
    const audit = one<{ after: string }>(`SELECT after FROM audit_logs WHERE action = 'booking.override' AND entity_id = ?`, bookingId)!;
    expect(JSON.parse(audit.after)).toMatchObject({ to: 'active', reason: 'Known customer' });
    expect(lastEvent(bookingId, 'override').note).toMatch(/^Pickup checks overridden \(Verify the driving licence .*\)\. Reason: Known customer$/);

    const rules = scalar<string>(`SELECT value FROM settings WHERE key = 'booking_rules'`)!;
    run(`UPDATE settings SET value = json_set(value, '$.km_limit_12h', 200, '$.extra_km_rate_paise', 1000) WHERE key = 'booking_rules'`);
    try {
      const ret = rpc(owner.ctx(), 'record_handover', { p_booking: bookingId, p_kind: 'return', p_odometer_km: 5250, p_fuel_level: 'three_quarter' });
      expect(ret).toEqual({
        ok: true,
        status: 'returned',
        km_driven: 250,
        fuel_diff_quarters: -1,
        late_hours: 3,
        suggested_late_fee_paise: 60000,
        extra_km: 50,
        suggested_km_charge_paise: 50000,
        deposit_held_paise: 0,
      });
      expect(lastEvent(bookingId).note).toBe('Returned. Odometer 5250 km (250 km driven), fuel three quarter, 3 h late.');
    } finally {
      run(`UPDATE settings SET value = ? WHERE key = 'booking_rules'`, rules);
    }

    // Closing with money outstanding needs a reason, recorded as an override.
    expectFail(
      () => transition(manager, bookingId, 'closed'),
      'unsettled',
      'Settle the booking first: balance ₹1,500, deposit held ₹0. To close anyway, give a reason.',
    );
    expect(transition(manager, bookingId, 'closed', undefined, 'Customer pays tomorrow')).toEqual({ ok: true, status: 'closed' });
    expect(bookingRow(bookingId).ended_at).not.toBeNull();
    expect(lastEvent(bookingId, 'override').note).toBe('Closed with balance ₹1,500 and deposit held ₹0. Reason: Customer pays tomorrow');
  });
});

describe('AC-10 staff scope', () => {
  it('staff cannot confirm bookings, and cannot act on bookings outside their window', () => {
    const later = websiteBooking('maruti-ertiga', '12h', addDaysIso(today(), 6), '10:00');
    expectFail(() => transition(staff, later.booking_id, 'confirmed'), 'not_found', 'Booking not found.');
    expectFail(() => rpc(staff.ctx(), 'pickup_gate_problems', { p_booking: later.booking_id }), 'not_found');
    const soon = rawBooking('tata-nexon-old', 1, 'requested');
    expectFail(() => transition(staff, soon.bookingId, 'confirmed'), 'state', "This booking can't move from requested to confirmed.");
  });
});

describe('AC-11 price change', () => {
  it('keeps the stored price on existing bookings and uses the new price for new ones', () => {
    const kia = carId('kia-sonet');
    const day = addDaysIso(today(), 4);
    const before = websiteBooking('kia-sonet', '12h', day, '09:00');
    transition(manager, before.booking_id, 'confirmed');
    const historyBefore = scalar<number>('SELECT count(*) FROM car_price_history WHERE car_id = ?', kia)!;
    tx(() => updateRow(owner.ctx(), 'cars', kia, { price_12h_paise: 200000 }));
    const after = websiteBooking('kia-sonet', '12h', addDaysIso(day, 2), '09:00');
    expect(bookingRow(before.booking_id).price_quoted_paise).toBe(180000);
    expect(after.price_paise).toBe(200000);
    // FLT-03: the change is in the price history, with who made it. (Postgres also logged the
    // seeded price on insert, so it had 2 rows here; seed.sql inserts cars without history.)
    expect(scalar('SELECT count(*) FROM car_price_history WHERE car_id = ?', kia)).toBe(historyBefore + 1);
    expect(one('SELECT price_12h_paise, changed_by FROM car_price_history WHERE car_id = ? ORDER BY changed_at DESC LIMIT 1', kia)).toEqual({
      price_12h_paise: 200000,
      changed_by: owner.id,
    });
  });
});

describe('Section 7 lifecycle, edits and extensions', () => {
  it('needs a reason to reject, and keeps it', () => {
    const r = websiteBooking('tata-nexon-new', '24h', addDaysIso(today(), 8), '10:00');
    expectFail(() => transition(manager, r.booking_id, 'rejected'), 'reason', 'Give a reason.');
    expectFail(() => transition(manager, r.booking_id, 'active'), 'use_handover', 'Use the handover checklist to record pickup and return.');
    expect(transition(manager, r.booking_id, 'rejected', 'Car booked offline')).toEqual({ ok: true, status: 'rejected' });
    const b = bookingRow(r.booking_id);
    expect(b.cancel_reason).toBe('Car booked offline');
    expect(b.ended_at).not.toBeNull();
    expect(lastEvent(r.booking_id)).toMatchObject({ from_status: 'requested', to_status: 'rejected', actor_id: manager.id, note: 'Car booked offline' });
    expectFail(() => transition(manager, r.booking_id, 'confirmed'), 'state', "This booking can't move from rejected to confirmed.");
  });

  it('edits a confirmed booking with reasons, and refuses to move it onto a held time (BKA-05)', () => {
    const day = addDaysIso(today(), 10);
    const r = websiteBooking('tata-nexon-new', '12h', day, '10:00');
    transition(manager, r.booking_id, 'confirmed');
    expectFail(() => transition(manager, r.booking_id, 'no_show'), 'state', 'You can mark a no-show only after the pickup time.');
    const edit = (args: Row) => rpc<{ ok: boolean; changed: boolean }>(manager.ctx(), 'update_booking', { p_booking: r.booking_id, ...args });

    expect(edit({})).toEqual({ ok: true, changed: false });
    expectFail(() => rpc(staff.ctx(), 'update_booking', { p_booking: r.booking_id }), 'forbidden');
    expectFail(() => edit({ p_price_paise: 150000 }), 'price_reason', 'A price override needs a reason.');
    expectFail(() => edit({ p_discount_paise: 10000 }), 'price_reason', 'A discount needs a reason.');

    const newPickup = fromIst(day, '12:00')!.toISOString();
    expect(edit({ p_pickup_at: newPickup, p_discount_paise: 20000, p_reason: 'Late pickup' })).toEqual({ ok: true, changed: true });
    expect(bookingRow(r.booking_id)).toMatchObject({
      pickup_at: newPickup,
      return_due_at: iso(Date.parse(newPickup) + 12 * HOUR),
      hold_until: iso(Date.parse(newPickup) + 13 * HOUR),
      discount_paise: 20000,
      total_paise: 180000,
    });
    expect(lastEvent(r.booking_id, 'edit').note).toBe(`Changed: pickup → ${formatWhen(newPickup)}, discount → ₹200. Reason: Late pickup`);

    const next = websiteBooking('tata-nexon-new', '12h', addDaysIso(day, 1), '10:00');
    transition(manager, next.booking_id, 'confirmed');
    expectFail(
      () => edit({ p_pickup_at: fromIst(addDaysIso(day, 1), '08:00')!.toISOString() }),
      'clash',
      new RegExp(`^This car is already booked: ${next.booking_code} \\(`),
    );
  });

  it('extends an Active booking and charges for it (BKA-09)', () => {
    const active = rawBooking('maruti-victoris-cng', -2, 'active'); // out since 2 hours ago, due back in 10
    const nextCustomer = rawBooking('maruti-victoris-cng', 14);
    const extend = (args: Row) => rpc<{ ok: boolean; return_due_at: string; price_paise: number }>(manager.ctx(), 'extend_booking', { p_booking: active.bookingId, ...args });

    expectFail(() => extend({ p_kind: 'days' }), 'hours', 'Choose how long to extend by.');
    expectFail(() => extend({ p_kind: 'hours', p_hours: 1, p_amount_paise: 1 }), 'price_reason');
    // ₹3,000 per 24 hrs → ₹125 per hour (rounded up to whole rupees).
    const r = extend({ p_kind: 'hours', p_hours: 2 });
    expect(r).toMatchObject({ ok: true, price_paise: 25000 });
    expect(bookingRow(active.bookingId)).toMatchObject({
      return_due_at: r.return_due_at,
      hold_until: iso(Date.parse(r.return_due_at) + HOUR),
      extra_charges_paise: 25000,
      total_paise: 175000,
    });
    expect(one('SELECT kind, amount_paise FROM booking_charges WHERE booking_id = ?', active.bookingId)).toEqual({ kind: 'extension', amount_paise: 25000 });

    const nextCode = bookingRow(nextCustomer.bookingId).booking_code as string;
    expectFail(
      () => extend({ p_kind: '12h' }),
      'clash',
      new RegExp(`^The car is booked next from .+ \\(${nextCode}\\)\\. Extend for less time, or move that booking\\.$`),
    );
  });

  it('puts a booking on hold with a reason (10.4)', () => {
    const { bookingId } = rawBooking('maruti-baleno', 30, 'requested');
    expectFail(() => rpc(manager.ctx(), 'set_booking_hold', { p_booking: bookingId, p_on_hold: true }), 'reason', 'Give a reason for the hold.');
    rpc(manager.ctx(), 'set_booking_hold', { p_booking: bookingId, p_on_hold: true, p_reason: 'Open challan' });
    expect(bookingRow(bookingId)).toMatchObject({ on_hold: 1, hold_reason: 'Open challan' });
    expect(lastEvent(bookingId, 'note').note).toBe('Put on hold: Open challan');
    rpc(manager.ctx(), 'set_booking_hold', { p_booking: bookingId, p_on_hold: false });
    expect(bookingRow(bookingId)).toMatchObject({ on_hold: 0, hold_reason: null });
    expectFail(() => rpc(staff.ctx(), 'set_booking_hold', { p_booking: bookingId, p_on_hold: false }), 'forbidden');
  });
});

describe('payments ledger', () => {
  it('keeps totals and payment status in step with payments and charges; refunds need Owner/Manager', () => {
    const { bookingId } = rawBooking('maruti-ertiga', 3);
    const pay = (user: TestUser, args: Row) => rpc<string>(user.ctx(), 'record_payment', { p_booking: bookingId, ...args });
    const ledger = () =>
      one(
        `SELECT payment_status, paid_paise, refunded_paise, extra_charges_paise, total_paise, deposit_received_paise
           FROM bookings WHERE id = ?`,
        bookingId,
      );

    const paymentId = pay(staff, { p_amount_paise: 100000, p_type: 'rent', p_method: 'upi', p_reference: 'UTR123' });
    expect(typeof paymentId).toBe('string');
    expect(ledger()).toMatchObject({ payment_status: 'part_paid', paid_paise: 100000 });
    expect(lastEvent(bookingId, 'payment').note).toBe('Rent ₹1,000 by UPI (ref UTR123)');
    pay(staff, { p_amount_paise: 50000, p_type: 'rent', p_method: 'cash' });
    expect(ledger()).toMatchObject({ payment_status: 'paid', paid_paise: 150000 });

    expectFail(() => pay(staff, { p_amount_paise: 0, p_type: 'rent', p_method: 'cash' }), 'amount', 'Enter an amount above zero.');
    expectFail(
      () => rpc(staff.ctx(), 'add_booking_charge', { p_booking: bookingId, p_kind: 'damage', p_amount_paise: 1000 }),
      'note',
      'Add a note describing the charge.',
    );
    const chargeId = rpc<string>(staff.ctx(), 'add_booking_charge', { p_booking: bookingId, p_kind: 'cleaning', p_amount_paise: 30000, p_note: 'Mud inside' });
    expect(ledger()).toMatchObject({ payment_status: 'part_paid', extra_charges_paise: 30000, total_paise: 180000 });
    expect(lastEvent(bookingId, 'charge').note).toBe('Charge added: cleaning ₹300 (Mud inside)');

    // PAY-03: refunds need Owner/Manager and a reason.
    expectFail(() => pay(staff, { p_amount_paise: 1000, p_type: 'refund', p_method: 'cash', p_note: 'goodwill' }), 'forbidden', /Only the Owner or a Manager/);
    expectFail(() => pay(manager, { p_amount_paise: 1000, p_type: 'refund', p_method: 'cash' }), 'note', 'Give a reason for the refund.');
    pay(manager, { p_amount_paise: 10000, p_type: 'refund', p_method: 'cash', p_note: 'Goodwill' });
    expect(ledger()).toMatchObject({ paid_paise: 140000, refunded_paise: 10000, payment_status: 'part_paid' });

    pay(staff, { p_amount_paise: 500000, p_type: 'deposit', p_method: 'cash' });
    expect(ledger()).toMatchObject({ deposit_received_paise: 500000 });
    expectFail(
      () => pay(manager, { p_amount_paise: 600000, p_type: 'deposit_refund', p_method: 'cash', p_note: 'Returned' }),
      'amount',
      'The refund is more than the deposit held.',
    );

    expectFail(() => rpc(staff.ctx(), 'remove_booking_charge', { p_charge: chargeId, p_reason: 'Waived' }), 'forbidden');
    expectFail(() => rpc(manager.ctx(), 'remove_booking_charge', { p_charge: chargeId, p_reason: ' ' }), 'reason');
    rpc(manager.ctx(), 'remove_booking_charge', { p_charge: chargeId, p_reason: 'Waived' });
    expect(ledger()).toMatchObject({ extra_charges_paise: 0, total_paise: 150000, paid_paise: 140000 });
    expect(lastEvent(bookingId, 'charge').note).toBe('Charge removed: cleaning ₹300. Reason: Waived');
    expectFail(() => rpc(manager.ctx(), 'remove_booking_charge', { p_charge: chargeId, p_reason: 'Again' }), 'not_found', 'Charge not found.');

    // Payments and charges are audited like the Postgres row triggers did.
    expect(scalar(`SELECT count(*) FROM audit_logs WHERE action = 'payments.insert' AND json_extract(after, '$.booking_id') = ?`, bookingId)).toBe(4);
    expect(scalar(`SELECT count(*) FROM audit_logs WHERE action = 'booking_charges.delete' AND entity_id = ?`, chargeId)).toBe(1);
  });
});

describe('public booking lookup', () => {
  it('shows status for the right code and mobile only', () => {
    const phone = nextPhone();
    const r = websiteBooking('maruti-baleno', '24h', addDaysIso(today(), 7), '11:00', { phone });
    expect(rpc(visitor(), 'lookup_booking', { p_code: ` ${r.booking_code.toLowerCase()} `, p_phone: phone })).toEqual({
      found: true,
      code: r.booking_code,
      status: 'Requested',
      car: 'Maruti Baleno',
      package: '24 hrs',
      pickup_at: r.pickup_at,
      return_due_at: r.return_due_at,
    });
    expect(rpc(visitor(), 'lookup_booking', { p_code: r.booking_code, p_phone: '9123456789' })).toEqual({ found: false });
    expect(rpc(visitor(), 'lookup_booking', { p_code: r.booking_code, p_phone: 'not a phone' })).toEqual({ found: false });
  });

  it('allows 10 lookups per hour from one address', () => {
    const from = anonCtx('198.51.100.7', 'vitest');
    const args = { p_code: 'KSR-000000-999', p_phone: '9123456789' };
    for (let i = 0; i < 10; i += 1) expect(rpc(from, 'lookup_booking', args)).toEqual({ found: false });
    expectFail(() => rpc(from, 'lookup_booking', args), 'rate_limited', 'Too many requests. Please call us.');
    expect(rpc(anonCtx('198.51.100.8', 'vitest'), 'lookup_booking', args)).toEqual({ found: false });
  });
});

describe('availability for visitors (FLE-05)', () => {
  it('lists busy windows for up to 4 days, without any personal data', () => {
    const now = Date.now();
    const rows = rpc<Row[]>(visitor(), 'public_busy_windows', { p_from: iso(now), p_to: iso(now + 30 * 24 * HOUR) });
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(['car_id', 'ends_at', 'kind', 'starts_at']);
    // The Victoris that is out now and its next confirmed customer (in 14 hours).
    expect(rows.filter((r) => r.car_id === carId('maruti-victoris-cng'))).toHaveLength(2);
    // Confirmed Nexon bookings 10+ days ahead are beyond the 4-day window.
    expect(rows.some((r) => r.car_id === carId('tata-nexon-new'))).toBe(false);
  });
});

describe('RPT-02 utilisation', () => {
  it('reports hours available, rented and utilisation per car for Owner/Manager', () => {
    const now = Date.now();
    const glanza = carId('toyota-glanza');
    run(
      `INSERT INTO maintenance_windows (car_id, starts_at, ends_at, reason, notes) VALUES (?, ?, ?, 'service', 'Oil change')`,
      glanza,
      iso(now - 6 * HOUR),
      iso(now - HOUR),
    );
    expect(rpc(staff.ctx(), 'car_clashes', { p_car: glanza, p_start: iso(now - 3 * HOUR), p_end: iso(now - 2 * HOUR) })).toMatchObject([
      { kind: 'maintenance', booking_code: null, status: null, note: 'service: Oil change' },
    ]);

    const range = { p_from: iso(now - 24 * HOUR), p_to: iso(now) };
    expectFail(() => rpc(staff.ctx(), 'report_utilisation', range), 'forbidden');
    const rows = rpc<Array<{ car_id: string; display_name: string; hours_available: number; hours_rented: number; utilisation: number }>>(
      manager.ctx(),
      'report_utilisation',
      range,
    );
    expect(rows).toHaveLength(11);
    expect(Object.keys(rows[0])).toEqual(['car_id', 'display_name', 'hours_available', 'hours_rented', 'utilisation']);
    expect(rows[0].display_name).toBe('Kia Sonet');
    expect(rows.find((r) => r.car_id === glanza)).toMatchObject({ hours_available: 19, hours_rented: 0, utilisation: 0 });
    // The Victoris has been out for the last 2 of 24 hours.
    expect(rows.find((r) => r.car_id === carId('maruti-victoris-cng'))).toMatchObject({ hours_available: 24, hours_rented: 2, utilisation: 0.0833 });
  });
});

describe('two-step verification (ADM-03)', () => {
  it('a Manager without two-step verification cannot use the booking functions', () => {
    const r = websiteBooking('maruti-ertiga', '12h', addDaysIso(today(), 12), '10:00');
    expectFail(() => rpc(manager.ctxAal1(), 'booking_transition', { p_booking: r.booking_id, p_to: 'confirmed' }), 'forbidden', 'Not allowed.');
    expectFail(() => rpc(manager.ctxAal1(), 'record_payment', { p_booking: r.booking_id, p_amount_paise: 100, p_type: 'rent', p_method: 'cash' }), 'forbidden');
    expect(transition(manager, r.booking_id, 'confirmed')).toEqual({ ok: true, status: 'confirmed' });
  });
});
