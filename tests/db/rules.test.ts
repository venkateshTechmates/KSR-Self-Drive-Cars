// Database rules and PRD acceptance criteria (Section 14), run against the real migrations.
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { addDaysIso, fromIst, istDateIso, weekdayOf } from '@shared/time.ts';
import { addStaff, asService, asUser, carId, createDb, pgError, type TestUser } from './harness.ts';

let db: PGlite;
let owner: TestUser;
let manager: TestUser;
let staff: TestUser;
let phoneSeq = 0;

const nextPhone = () => `98${String(76500000 + (phoneSeq += 1)).padStart(8, '0')}`;

interface CreateResult {
  ok: boolean;
  booking_id: string;
  booking_code: string;
  customer_id: string;
  price_paise: number;
  pickup_at: string;
  return_due_at: string;
  flags: string[];
  error?: string;
  suggestions?: Array<{ slug: string }>;
}

async function websiteBooking(slug: string, pkg: '12h' | '24h', date: string, time: string, opts: { phone?: string; reject?: boolean } = {}) {
  const car = await carId(db, slug);
  const at = fromIst(date, time)!.toISOString();
  return asService(db, async () => {
    const r = await db.query<{ r: CreateResult }>(
      `select public._create_booking($1, $2::public.booking_package, $3::timestamptz, null, 'Ravi Kumar', $4, 'TS0920110012345',
         null, 'website', null, 'privacy-en-v1', 'website', '203.0.113.9', 'vitest', $5, false) as r`,
      [car, pkg, at, opts.phone ?? nextPhone(), opts.reject ?? true],
    );
    return r.rows[0].r;
  });
}

/** Insert a booking directly (bypasses the pickup rules), for "today" scenarios. */
async function rawBooking(slug: string, pickupOffsetHours: number, status = 'confirmed') {
  const car = await carId(db, slug);
  const phone = `+91${nextPhone()}`;
  const c = await db.query<{ id: string }>(
    `insert into public.customers (full_name, phone, dl_number) values ('Sita Devi', $1, 'AP0920150001234') returning id`,
    [phone],
  );
  const b = await db.query<{ id: string }>(
    `insert into public.bookings (booking_code, customer_id, car_id, package, pickup_at, return_due_at, hold_until, status, price_quoted_paise)
     values (public.next_booking_code(), $1, $2, '12h', now() + make_interval(hours => $3), now() + make_interval(hours => $3 + 12),
             now() + make_interval(hours => $3 + 12), $4::public.booking_status, 150000) returning id`,
    [c.rows[0].id, car, pickupOffsetHours, status],
  );
  return { bookingId: b.rows[0].id, customerId: c.rows[0].id, phone };
}

async function transition(user: TestUser, booking: string, to: string, note?: string, override?: string) {
  return asUser(db, user, () =>
    db.query(`select public.booking_transition($1, $2::public.booking_status, $3, $4) as r`, [booking, to, note ?? null, override ?? null]),
  );
}

function nextWeekday(day: 'sat' | 'wed', minDaysAhead = 1): string {
  let d = addDaysIso(istDateIso(), minDaysAhead);
  while (weekdayOf(d) !== day) d = addDaysIso(d, 1);
  return d;
}

beforeAll(async () => {
  db = await createDb();
  owner = await addStaff(db, 'owner');
  manager = await addStaff(db, 'manager');
  staff = await addStaff(db, 'staff');
});

describe('AC-01 complete request', () => {
  it('creates a Requested booking with a KSR code, the 24 hr price and the return time, and queues an email', async () => {
    const tomorrow = addDaysIso(istDateIso(), 1);
    const r = await websiteBooking('kia-sonet', '24h', tomorrow, '10:00');
    expect(r.ok).toBe(true);
    expect(r.booking_code).toMatch(/^KSR-\d{6}-\d{3}$/);
    expect(r.price_paise).toBe(350000);
    expect(new Date(r.return_due_at).getTime() - new Date(r.pickup_at).getTime()).toBe(24 * 3600 * 1000);
    expect(new Date(r.pickup_at).toISOString()).toBe(fromIst(tomorrow, '10:00')!.toISOString());

    const b = await db.query<{ status: string; source: string; consent_id: string | null }>(
      'select status, source, consent_id from public.bookings where id = $1',
      [r.booking_id],
    );
    expect(b.rows[0]).toMatchObject({ status: 'requested', source: 'website' });
    expect(b.rows[0].consent_id).not.toBeNull();
    const mail = await db.query<{ kind: string; subject: string }>(
      `select kind, subject from public.outbox where payload ->> 'booking_code' = $1`,
      [r.booking_code],
    );
    expect(mail.rows[0].kind).toBe('new_request');
  });

  it('numbers codes sequentially per day', async () => {
    const tomorrow = addDaysIso(istDateIso(), 1);
    const a = await websiteBooking('toyota-glanza', '12h', tomorrow, '09:00');
    const b = await websiteBooking('hyundai-i20', '12h', tomorrow, '09:00');
    expect(Number(b.booking_code.slice(-3))).toBe(Number(a.booking_code.slice(-3)) + 1);
  });

  it('matches repeat customers by mobile number', async () => {
    const phone = nextPhone();
    const day = addDaysIso(istDateIso(), 2);
    const a = await websiteBooking('maruti-baleno', '12h', day, '09:00', { phone });
    const b = await websiteBooking('maruti-baleno', '12h', addDaysIso(day, 1), '09:00', { phone: `+91 ${phone}` });
    expect(b.customer_id).toBe(a.customer_id);
  });

  it('rejects pickups outside opening hours and too soon', async () => {
    const tomorrow = addDaysIso(istDateIso(), 1);
    await expect(websiteBooking('kia-sonet', '12h', tomorrow, '22:00')).rejects.toThrow(/We hand over cars between 8:00 am and 8:00 pm/);
    await expect(websiteBooking('kia-sonet', '12h', tomorrow, '10:15')).rejects.toThrow(/30-minute step/);
    await expect(websiteBooking('kia-sonet', '12h', addDaysIso(istDateIso(), 90), '10:00')).rejects.toThrow(/up to 60 days/);
  });
});

describe('AC-03 no full Aadhaar', () => {
  it('has no column that can hold a full Aadhaar number', async () => {
    const r = await db.query<{ table_name: string; column_name: string; data_type: string; len: number | null }>(
      `select table_name, column_name, data_type, character_maximum_length as len
         from information_schema.columns where table_schema = 'public' and column_name ilike '%aadhaar%'`,
    );
    for (const col of r.rows) {
      expect(col.data_type === 'boolean' || (col.len !== null && col.len <= 4)).toBe(true);
    }
  });
});

describe('AC-04 clash blocked', () => {
  it('refuses to confirm an overlapping booking and names the clashing one', async () => {
    const sat = nextWeekday('sat');
    const first = await websiteBooking('maruti-xl6-cng', '12h', sat, '09:00');
    await transition(manager, first.booking_id, 'confirmed');
    const second = await websiteBooking('maruti-xl6-cng', '12h', sat, '15:00', { reject: false });
    expect(second.flags).toContain('clash');
    try {
      await transition(manager, second.booking_id, 'confirmed');
      expect.unreachable();
    } catch (err) {
      const e = pgError(err);
      expect(e.detail).toBe('clash');
      expect(e.message).toContain(first.booking_code);
    }
  });

  it('website requests for a held car are refused with same-category suggestions', async () => {
    const sat = nextWeekday('sat');
    const r = await websiteBooking('maruti-xl6-cng', '12h', sat, '10:00', { reject: true });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('clash');
    expect(r.suggestions!.map((s) => s.slug)).toContain('maruti-ertiga');
  });

  it('the exclusion constraint stops overlaps even without the function checks', async () => {
    const sat = nextWeekday('sat');
    const r = await db.query<{ id: string }>(
      `select id from public.bookings where car_id = (select id from public.cars where slug = 'maruti-xl6-cng')
         and status = 'requested' and public.ist_date(pickup_at) = $1::date limit 1`,
      [sat],
    );
    await expect(db.query(`update public.bookings set status = 'confirmed' where id = $1`, [r.rows[0].id])).rejects.toThrow(/bookings_no_overlap/);
  });
});

describe('AC-05 expired papers', () => {
  it('blocks confirmation unless the Owner overrides with a reason, which is audited', async () => {
    const punch = await carId(db, 'tata-punch-cng');
    await db.query(
      `insert into public.documents (owner_type, car_id, doc_type, storage_path, original_filename, mime_type, size_bytes, sha256, expiry_date, status)
       values ('car', $1, 'insurance', 'vehicles/x/insurance/a.pdf', 'ins.pdf', 'application/pdf', 1000, repeat('a', 64), public.ist_today() - 1, 'expired')`,
      [punch],
    );
    const r = await websiteBooking('tata-punch-cng', '12h', addDaysIso(istDateIso(), 3), '10:00');
    try {
      await transition(manager, r.booking_id, 'confirmed');
      expect.unreachable();
    } catch (err) {
      expect(pgError(err).detail).toBe('papers_expired');
    }
    // Manager cannot override.
    await expect(transition(manager, r.booking_id, 'confirmed', undefined, 'urgent')).rejects.toThrow(/Owner can override/);
    await transition(owner, r.booking_id, 'confirmed', undefined, 'Renewal paid, certificate awaited');
    const audit = await db.query<{ after: { reason: string } }>(
      `select after from public.audit_logs where action = 'booking.override' and entity_id = $1`,
      [r.booking_id],
    );
    expect(audit.rows[0].after.reason).toBe('Renewal paid, certificate awaited');
  });
});

describe('AC-09 pickup gate', () => {
  it('requires a verified licence valid past the return time and verified identity', async () => {
    const { bookingId, customerId } = await rawBooking('maruti-suzuki-fronx', 1);
    try {
      await asUser(db, staff, () => db.query(`select public.record_handover($1, 'pickup', 12000, 'full')`, [bookingId]));
      expect.unreachable();
    } catch (err) {
      const e = pgError(err);
      expect(e.detail).toBe('pickup_gate');
      expect(e.message).toMatch(/Verify the driving licence/);
    }

    const doc = await db.query<{ id: string }>(
      `insert into public.documents (owner_type, customer_id, doc_type, storage_path, original_filename, mime_type, size_bytes, sha256)
       values ('customer', $1, 'dl_front', 'customers/x/dl_front/' || gen_random_uuid() || '.jpg', 'dl.jpg', 'image/jpeg', 2000, repeat('b', 64))
       returning id`,
      [customerId],
    );
    await asUser(db, staff, () =>
      db.query(`select public.verify_document($1, 'verified', 'original_seen', null, public.ist_today() + 400)`, [doc.rows[0].id]),
    );
    await asUser(db, staff, () =>
      db.query(`select public.verify_customer_identity($1, 'aadhaar_qr', '1234', true, $2)`, [customerId, bookingId]),
    );
    const r = await asUser(db, staff, () =>
      db.query<{ r: { status: string } }>(`select public.record_handover($1, 'pickup', 12000, 'full') as r`, [bookingId]),
    );
    expect(r.rows[0].r.status).toBe('active');
    const cust = await db.query<{ aadhaar_last4: string; identity_method: string }>(
      'select aadhaar_last4, identity_method from public.customers where id = $1',
      [customerId],
    );
    expect(cust.rows[0]).toEqual({ aadhaar_last4: '1234', identity_method: 'aadhaar_qr' });

    // Return computes km and lateness.
    const ret = await asUser(db, staff, () =>
      db.query<{ r: { km_driven: number; status: string } }>(`select public.record_handover($1, 'return', 12250, 'half') as r`, [bookingId]),
    );
    expect(ret.rows[0].r).toMatchObject({ status: 'returned', km_driven: 250 });
  });
});

describe('AC-10 staff scope', () => {
  it('hides customers without a booking today, even from direct queries', async () => {
    const later = await websiteBooking('maruti-ertiga', '12h', addDaysIso(istDateIso(), 5), '10:00');
    const today = await rawBooking('tata-nexon-old', 1);
    const seen = await asUser(db, staff, () =>
      db.query<{ id: string }>('select id from public.customers where id = any($1::uuid[])', [[later.customer_id, today.customerId]]),
    );
    expect(seen.rows.map((r) => r.id)).toEqual([today.customerId]);
    const asManager = await asUser(db, manager, () =>
      db.query<{ id: string }>('select id from public.customers where id = any($1::uuid[])', [[later.customer_id, today.customerId]]),
    );
    expect(asManager.rows).toHaveLength(2);
  });

  it('staff cannot confirm bookings or download KYC', async () => {
    const r = await websiteBooking('maruti-ertiga', '12h', addDaysIso(istDateIso(), 6), '10:00');
    await expect(transition(staff, r.booking_id, 'confirmed')).rejects.toThrow();
    // A licence for a customer whose booking is next week, not today.
    const dl = await db.query<{ id: string }>(
      `insert into public.documents (owner_type, customer_id, doc_type, storage_path, original_filename, mime_type, size_bytes, sha256)
       values ('customer', $1, 'dl_front', 'customers/w/' || gen_random_uuid() || '.jpg', 'dl.jpg', 'image/jpeg', 2000, repeat('e', 64))
       returning id`,
      [r.customer_id],
    );
    const hidden = await asUser(db, staff, () => db.query('select id from public.documents where id = $1', [dl.rows[0].id]));
    expect(hidden.rows).toHaveLength(0);

    // Today's customer (from AC-09): staff may view the licence but not download it.
    const todays = await db.query<{ id: string }>(
      `select d.id from public.documents d join public.bookings b on b.customer_id = d.customer_id
        where d.doc_type = 'dl_front' and b.status = 'returned' limit 1`,
    );
    const can = await asUser(db, staff, () =>
      db.query<{ v: boolean; d: boolean }>(
        `select public.can_view_document(d) as v, public.can_download_document(d) as d from public.documents d where id = $1`,
        [todays.rows[0].id],
      ),
    );
    expect(can.rows[0]).toEqual({ v: true, d: false });
  });
});

describe('AC-11 price change', () => {
  it('keeps the stored price on existing bookings and uses the new price for new ones', async () => {
    const day = addDaysIso(istDateIso(), 4);
    const before = await websiteBooking('kia-sonet', '12h', day, '09:00');
    await transition(manager, before.booking_id, 'confirmed');
    await asUser(db, owner, () => db.query(`update public.cars set price_12h_paise = 200000 where slug = 'kia-sonet'`));
    const after = await websiteBooking('kia-sonet', '12h', addDaysIso(day, 2), '09:00');
    const stored = await db.query<{ price_quoted_paise: number }>('select price_quoted_paise from public.bookings where id = $1', [before.booking_id]);
    expect(stored.rows[0].price_quoted_paise).toBe(180000);
    expect(after.price_paise).toBe(200000);
    const hist = await db.query<{ n: number }>(
      `select count(*)::int as n from public.car_price_history where car_id = (select id from public.cars where slug = 'kia-sonet')`,
    );
    expect(hist.rows[0].n).toBe(2);
  });
});

describe('AC-12 retention purge', () => {
  it('lists an expired masked Aadhaar for erasure and records the erasure', async () => {
    const { customerId } = await rawBooking('hyundai-i20', 200, 'requested');
    const doc = await db.query<{ id: string }>(
      `insert into public.documents (owner_type, customer_id, doc_type, storage_path, original_filename, mime_type, size_bytes, sha256,
         aadhaar_masked_confirmed, retain_until)
       values ('customer', $1, 'aadhaar_masked', 'customers/y/aadhaar/' || gen_random_uuid() || '.jpg', 'a.jpg', 'image/jpeg', 100,
         repeat('c', 64), true, now() - interval '1 day') returning id`,
      [customerId],
    );
    const due = await asService(db, () => db.query<{ id: string }>('select id from public._retention_due(500)'));
    expect(due.rows.map((r) => r.id)).toContain(doc.rows[0].id);
    await asService(db, () => db.query(`select public._erase_document($1, 'retention')`, [doc.rows[0].id]));
    const gone = await db.query('select 1 from public.documents where id = $1', [doc.rows[0].id]);
    expect(gone.rows).toHaveLength(0);
    const audit = await db.query(`select 1 from public.audit_logs where action = 'document.erase' and entity_id = $1`, [doc.rows[0].id]);
    expect(audit.rows).toHaveLength(1);
  });

  it('skips documents on hold', async () => {
    const { customerId } = await rawBooking('hyundai-i20', 300, 'requested');
    const doc = await db.query<{ id: string }>(
      `insert into public.documents (owner_type, customer_id, doc_type, storage_path, original_filename, mime_type, size_bytes, sha256,
         aadhaar_masked_confirmed, retain_until, legal_hold, hold_reason)
       values ('customer', $1, 'aadhaar_masked', 'customers/z/' || gen_random_uuid() || '.jpg', 'a.jpg', 'image/jpeg', 100,
         repeat('d', 64), true, now() - interval '1 day', true, 'Open claim') returning id`,
      [customerId],
    );
    const due = await asService(db, () => db.query<{ id: string }>('select id from public._retention_due(500)'));
    expect(due.rows.map((r) => r.id)).not.toContain(doc.rows[0].id);
  });
});

describe('access control', () => {
  it('Owner and Manager see nothing until two-step verification (aal2)', async () => {
    const aal1 = await asUser(db, manager, () => db.query<{ n: number }>('select count(*)::int as n from public.bookings'), 'aal1');
    expect(aal1.rows[0].n).toBe(0);
    const aal2 = await asUser(db, manager, () => db.query<{ n: number }>('select count(*)::int as n from public.bookings'));
    expect(aal2.rows[0].n).toBeGreaterThan(0);
  });

  it('a deactivated account loses access immediately', async () => {
    const temp = await addStaff(db, 'manager', 'temp');
    await db.query('update public.staff_profiles set active = false where user_id = $1', [temp.id]);
    const r = await asUser(db, temp, () => db.query<{ n: number }>('select count(*)::int as n from public.cars'));
    expect(r.rows[0].n).toBe(0);
  });

  it('visitors read only the public views', async () => {
    const cars = await asUser(db, null, () => db.query<Record<string, unknown>>('select * from public.public_cars'));
    expect(cars.rows.length).toBe(11);
    expect(Object.keys(cars.rows[0])).not.toContain('registration_number');
    await expect(asUser(db, null, () => db.query('select * from public.customers'))).rejects.toThrow(/permission denied/);
    await expect(asUser(db, null, () => db.query('select * from public.bookings'))).rejects.toThrow(/permission denied/);
    const settings = await asUser(db, null, () => db.query<{ key: string }>('select key from public.public_settings order by key'));
    expect(settings.rows.map((r) => r.key)).toEqual(['booking_rules', 'business']);
  });

  it('only the Owner reads the audit log, and nobody can change it', async () => {
    const m = await asUser(db, manager, () => db.query<{ n: number }>('select count(*)::int as n from public.audit_logs'));
    expect(m.rows[0].n).toBe(0);
    const o = await asUser(db, owner, () => db.query<{ n: number }>('select count(*)::int as n from public.audit_logs'));
    expect(o.rows[0].n).toBeGreaterThan(0);
    await expect(db.query(`update public.audit_logs set action = 'x'`)).rejects.toThrow(/cannot be changed/);
    await expect(db.query(`delete from public.audit_logs`)).rejects.toThrow(/cannot be changed/);
  });

  it('logs who changed a car price, with before and after', async () => {
    const r = await db.query<{ actor_id: string; before: Record<string, number>; after: Record<string, number> }>(
      `select actor_id, before, after from public.audit_logs where action = 'cars.update' and after ? 'price_12h_paise' order by at desc limit 1`,
    );
    expect(r.rows[0]).toMatchObject({ actor_id: owner.id, before: { price_12h_paise: 180000 }, after: { price_12h_paise: 200000 } });
  });
});

describe('abuse protection', () => {
  it('rate-limits 5 submissions per mobile number per hour', async () => {
    const results = await asService(db, async () => {
      const out: boolean[] = [];
      for (let i = 0; i < 6; i += 1) {
        const r = await db.query<{ ok: boolean }>(`select public._register_submission('booking', '+919000000001', 'iphash', 5, 20) as ok`);
        out.push(r.rows[0].ok);
      }
      return out;
    });
    expect(results).toEqual([true, true, true, true, true, false]);
  });

  it('locks an account after 5 failed logins', async () => {
    const decisions: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const r = await db.query<{ r: { decision: string } }>(
        `select public.hook_password_verification_attempt($1::jsonb) as r`,
        [JSON.stringify({ user_id: staff.id, valid: i === 5 })],
      );
      decisions.push(r.rows[0].r.decision);
    }
    expect(decisions).toEqual(['continue', 'continue', 'continue', 'continue', 'reject', 'reject']);
    const mail = await db.query(`select 1 from public.outbox where kind = 'lockout'`);
    expect(mail.rows.length).toBe(1);
  });
});

describe('payments ledger', () => {
  it('keeps totals and payment status in step with payments and charges; refunds need Owner/Manager', async () => {
    const { bookingId } = await rawBooking('maruti-ertiga', 3);
    await asUser(db, staff, () => db.query(`select public.record_payment($1, 100000, 'rent', 'upi', 'UTR123')`, [bookingId]));
    let b = await db.query<{ payment_status: string; paid_paise: number }>('select payment_status, paid_paise from public.bookings where id = $1', [bookingId]);
    expect(b.rows[0]).toEqual({ payment_status: 'part_paid', paid_paise: 100000 });
    await asUser(db, staff, () => db.query(`select public.record_payment($1, 50000, 'rent', 'cash')`, [bookingId]));
    b = await db.query('select payment_status, paid_paise from public.bookings where id = $1', [bookingId]);
    expect(b.rows[0].payment_status).toBe('paid');
    await asUser(db, staff, () => db.query(`select public.add_booking_charge($1, 'cleaning', 30000, 'Mud inside')`, [bookingId]));
    b = await db.query('select payment_status, paid_paise from public.bookings where id = $1', [bookingId]);
    expect(b.rows[0].payment_status).toBe('part_paid');
    await expect(
      asUser(db, staff, () => db.query(`select public.record_payment($1, 1000, 'refund', 'cash', null, 'goodwill')`, [bookingId])),
    ).rejects.toThrow(/Only the Owner or a Manager/);
  });
});

describe('public booking lookup', () => {
  it('shows status for the right code and mobile only', async () => {
    const phone = nextPhone();
    const r = await websiteBooking('maruti-baleno', '24h', addDaysIso(istDateIso(), 7), '11:00', { phone });
    const found = await asUser(db, null, () =>
      db.query<{ r: { found: boolean; status: string } }>('select public.lookup_booking($1, $2) as r', [r.booking_code, phone]),
    );
    expect(found.rows[0].r).toMatchObject({ found: true, status: 'Requested' });
    const wrong = await asUser(db, null, () =>
      db.query<{ r: { found: boolean } }>('select public.lookup_booking($1, $2) as r', [r.booking_code, '9123456789']),
    );
    expect(wrong.rows[0].r.found).toBe(false);
  });
});
