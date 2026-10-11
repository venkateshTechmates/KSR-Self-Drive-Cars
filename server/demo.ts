// Demo data: a Manager and a Staff account, customers, bookings in every state, payments, a
// maintenance window and vehicle papers. Used by `npm run seed-demo` (try the admin with data)
// and by the Playwright end-to-end tests (e2e/). Bookings are made with the real business
// functions, then some are moved into the past to show cars out now, overdue and returned.
import { createHash } from 'node:crypto';
import type { Booking } from '../src/types/db.ts';
import { addDaysIso, fromIst, istDateIso, MS_HOUR } from '../shared/time.ts';
import { userCtx, type Ctx } from './access/context.ts';
import { encryptSecret, hashPassword, passwordProblem } from './auth/crypto.ts';
import { all, nowIso, one, run, tx, uuid } from './db/connection.ts';
import { getRow, insertRow } from './db/write.ts';
import { createBooking, recomputeLedger, saveBooking } from './rpc/booking.ts';
import { registerDocument } from './rpc/documents.ts';
import { demoPng } from './png.ts';
import { getRpc } from './rpc/index.ts';
import { currentNoticeVersion } from './settings.ts';
import { saveFile } from './storage.ts';

export interface DemoOptions {
  /** Password for the demo Manager and Staff accounts. */
  password: string;
  managerEmail?: string;
  staffEmail?: string;
  /** Base32 TOTP secret to enrol the Manager with (tests); otherwise they set it up on first sign-in. */
  managerTotpSecret?: string | null;
}

export interface DemoCustomer {
  name: string;
  phone: string;
}

export interface DemoBooking {
  code: string;
  car: string;
  customer: DemoCustomer;
}

export interface DemoResult {
  manager: { email: string; name: string };
  staff: { email: string; name: string };
  bookings: Record<DemoScenario, DemoBooking>;
  /** Car id by slug. */
  cars: Record<string, string>;
}

export type DemoScenario =
  | 'requested'
  | 'papersExpired'
  | 'clashConfirmed'
  | 'clashRequested'
  | 'toReject'
  | 'pickupToday'
  | 'active'
  | 'overdue'
  | 'returned'
  | 'closed'
  | 'rejected';

export const hasBookings = () => Boolean(one('SELECT 1 FROM bookings LIMIT 1'));

// ------------------------------------------------------------------ helpers

const carId = (slug: string): string => {
  const row = one<{ id: string }>('SELECT id FROM cars WHERE slug = ?', slug);
  if (!row) throw new Error(`Demo data: no car ${slug}`);
  return row.id;
};

/** IST date `days` from today at `time` (HH:MM), as ISO. */
const istAt = (days: number, time: string): string => fromIst(addDaysIso(istDateIso(), days), time)!.toISOString();

/** Now plus `hours`, rounded down to the half hour, as ISO. */
const hoursFromNow = (hours: number): string => {
  const ms = Date.now() + hours * MS_HOUR;
  return new Date(ms - (ms % (30 * 60_000))).toISOString();
};

function rpc(ctx: Ctx, name: string, args: Record<string, unknown>): unknown {
  const def = getRpc(name);
  if (!def) throw new Error(`Demo data: no RPC ${name}`);
  return def.handler(ctx, args);
}

async function addStaffAccount(email: string, name: string, role: 'manager' | 'staff', password: string, totpSecret: string | null): Promise<string> {
  const hash = await hashPassword(password);
  return tx(() => {
    const clean = email.trim().toLowerCase();
    if (one('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE', clean)) throw new Error(`Demo data: ${clean} already exists`);
    const id = uuid();
    const now = nowIso();
    run(
      'INSERT INTO users (id, email, password_hash, totp_secret, totp_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      clean,
      hash,
      totpSecret ? encryptSecret(totpSecret) : null,
      totpSecret ? 1 : 0,
      now,
      now,
    );
    run('INSERT INTO staff_profiles (user_id, full_name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', id, name, clean, now, now);
    run('INSERT INTO user_roles (id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', uuid(), id, role, now, now);
    return id;
  });
}

async function addDocument(
  ctx: Ctx,
  ownerType: 'car' | 'customer',
  ownerId: string,
  docType: string,
  opts: { expiryDate?: string | null; docNumber?: string | null; filename: string; rgb?: [number, number, number] },
): Promise<string> {
  const bytes = demoPng(120, 80, opts.rgb);
  const fileId = uuid();
  const folder = ownerType === 'car' ? 'vehicles' : 'customers';
  const path = `${folder}/${ownerId}/${docType}/${fileId}.png`;
  await saveFile('documents', path, bytes);
  return tx(
    () =>
      registerDocument(ctx, {
        actorId: ctx.userId,
        ownerType,
        ownerId,
        docType,
        storagePath: path,
        originalFilename: opts.filename,
        mime: 'image/png',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        docNumber: opts.docNumber ?? null,
        expiryDate: opts.expiryDate ?? null,
        uploadedVia: 'admin',
      }).id,
  );
}

// ------------------------------------------------------------------ the data

interface Plan {
  key: DemoScenario;
  car: string;
  customer: DemoCustomer & { dl: string; email?: string };
  pkg: '12h' | '24h';
  /** Pickup when the booking is made (today or later). */
  pickupAt: string;
  source: 'website' | 'phone' | 'walk_in' | 'whatsapp';
}

const customer = (name: string, n: number, dl: string, email?: string) => ({ name, phone: `+9198765${String(n).padStart(5, '0')}`, dl, email });

export async function seedDemoData(opts: DemoOptions): Promise<DemoResult> {
  const problem = passwordProblem(opts.password);
  if (problem) throw new Error(`Demo password: ${problem}`);
  const managerEmail = opts.managerEmail ?? 'manager@ksr.test';
  const staffEmail = opts.staffEmail ?? 'staff@ksr.test';
  const managerId = await addStaffAccount(managerEmail, 'Meena Rao', 'manager', opts.password, opts.managerTotpSecret ?? null);
  await addStaffAccount(staffEmail, 'Sanjay Kumar', 'staff', opts.password, null);
  const ctx = userCtx({ userId: managerId, email: managerEmail, sessionId: null, aal: 'aal2', ip: null, ua: 'demo-seed' });

  // Vehicle papers: Kia Sonet insurance expires in 10 days; Tata Punch CNG insurance expired yesterday.
  await addDocument(ctx, 'car', carId('kia-sonet'), 'insurance', { expiryDate: addDaysIso(istDateIso(), 10), docNumber: 'POL-55120931', filename: 'sonet-insurance.png' });
  await addDocument(ctx, 'car', carId('tata-punch-cng'), 'insurance', { expiryDate: addDaysIso(istDateIso(), -1), docNumber: 'POL-55120477', filename: 'punch-insurance.png' });

  const plans: Plan[] = [
    { key: 'requested', car: 'kia-sonet', customer: customer('Ravi Kumar', 1, 'TS0920110012345', 'ravi@example.com'), pkg: '24h', pickupAt: istAt(1, '10:00'), source: 'website' },
    { key: 'papersExpired', car: 'tata-punch-cng', customer: customer('Farah Khan', 11, 'TS0720190004411'), pkg: '12h', pickupAt: istAt(2, '11:00'), source: 'website' },
    { key: 'clashConfirmed', car: 'maruti-xl6-cng', customer: customer('Anita Sharma', 2, 'TS0820150067890'), pkg: '24h', pickupAt: istAt(3, '10:00'), source: 'phone' },
    { key: 'clashRequested', car: 'maruti-xl6-cng', customer: customer('Suresh Reddy', 3, 'AP0320180023456'), pkg: '12h', pickupAt: istAt(3, '18:00'), source: 'whatsapp' },
    { key: 'toReject', car: 'hyundai-i20', customer: customer('Rahul Verma', 10, 'TS1020200031234'), pkg: '24h', pickupAt: istAt(4, '09:00'), source: 'website' },
    { key: 'pickupToday', car: 'maruti-baleno', customer: customer('Priya Nair', 4, 'TS0920170045678', 'priya@example.com'), pkg: '24h', pickupAt: istAt(0, '19:30'), source: 'phone' },
    { key: 'active', car: 'toyota-glanza', customer: customer('Mohammed Irfan', 5, 'TS1120160056789'), pkg: '24h', pickupAt: istAt(20, '10:00'), source: 'walk_in' },
    { key: 'overdue', car: 'maruti-ertiga', customer: customer('Lakshmi Devi', 6, 'TS0520140067891'), pkg: '24h', pickupAt: istAt(21, '10:00'), source: 'phone' },
    { key: 'returned', car: 'maruti-suzuki-fronx', customer: customer('Karthik Rao', 7, 'KA0120190078912'), pkg: '24h', pickupAt: istAt(22, '10:00'), source: 'website' },
    { key: 'closed', car: 'tata-nexon-old', customer: customer('Deepa Menon', 8, 'KL0720120089123'), pkg: '24h', pickupAt: istAt(23, '10:00'), source: 'website' },
    { key: 'rejected', car: 'maruti-victoris-cng', customer: customer('Vijay Kumar', 9, 'TS0120210091234'), pkg: '24h', pickupAt: istAt(5, '10:00'), source: 'website' },
  ];

  const made = {} as Record<DemoScenario, { id: string; code: string }>;
  for (const p of plans) {
    const res = tx(() =>
      createBooking(ctx, {
        carId: carId(p.car),
        package: p.pkg,
        pickupAt: p.pickupAt,
        customHours: null,
        fullName: p.customer.name,
        phone: p.customer.phone,
        dlNumber: p.customer.dl,
        email: p.customer.email ?? null,
        source: p.source,
        createdBy: p.source === 'website' ? null : managerId,
        noticeVersion: currentNoticeVersion(),
        consentChannel: p.source === 'website' ? 'website' : 'admin',
        ip: null,
        userAgent: 'demo-seed',
        rejectOnClash: false,
        staff: true,
      }),
    );
    if (!res.ok) throw new Error(`Demo data: couldn't create ${p.key}`);
    made[p.key] = { id: res.booking_id, code: res.booking_code };
  }

  const booking = (key: DemoScenario) => getRow<Booking>('bookings', made[key].id)!;
  const transition = (key: DemoScenario, to: string, note: string | null = null) =>
    tx(() => rpc(ctx, 'booking_transition', { p_booking: made[key].id, p_to: to, p_note: note, p_override_reason: null }));
  const pay = (key: DemoScenario, type: string, rupees: number, method: string, receivedAt: string, note = '') =>
    tx(() =>
      rpc(ctx, 'record_payment', {
        p_booking: made[key].id,
        p_amount_paise: rupees * 100,
        p_type: type,
        p_method: method,
        p_reference: method === 'upi' ? `UPI${Math.floor(Date.parse(receivedAt) / 1000)}` : null,
        p_note: note,
        p_receipt_document_id: null,
        p_received_at: receivedAt,
      }),
    );
  /** Move a booking's times (it was made in the future so the pickup rules accept it). */
  const reschedule = (key: DemoScenario, pickupAt: string) =>
    tx(() => {
      const b = booking(key);
      const hours = b.package === '12h' ? 12 : 24;
      saveBooking(ctx, b, { pickup_at: pickupAt, return_due_at: new Date(Date.parse(pickupAt) + hours * MS_HOUR).toISOString() });
    });
  /** Hand over (or take back) a car at a given time, as the handover checklist would. */
  const handover = (key: DemoScenario, kind: 'pickup' | 'return', at: string, km: number, fuel: string) =>
    tx(() => {
      const b = booking(key);
      insertRow(ctx, 'handover_records', {
        booking_id: b.id,
        kind,
        odometer_km: km,
        fuel_level: fuel,
        checklist: { documents_checked: true, photos_taken: true, fuel_noted: true },
        damage_notes: '',
        recorded_by: managerId,
        recorded_at: at,
      });
      const to = kind === 'pickup' ? 'active' : 'returned';
      saveBooking(ctx, b, kind === 'pickup' ? { status: 'active', actual_pickup_at: at } : { status: 'returned', actual_return_at: at });
      insertRow(ctx, 'booking_events', {
        booking_id: b.id,
        kind: 'status',
        from_status: b.status,
        to_status: to,
        actor_id: managerId,
        at,
        note: kind === 'pickup' ? `Picked up. Odometer ${km} km, fuel ${fuel.replace(/_/g, ' ')}.` : `Returned. Odometer ${km} km, fuel ${fuel.replace(/_/g, ' ')}.`,
      });
    });

  // Confirmed: XL6 (the other XL6 request clashes with it) and today's Baleno pickup.
  transition('clashConfirmed', 'confirmed');
  transition('pickupToday', 'confirmed');
  transition('rejected', 'rejected', 'Licence not valid for this car.');

  // Out now: picked up 3 hours ago.
  reschedule('active', hoursFromNow(-3));
  transition('active', 'confirmed');
  handover('active', 'pickup', hoursFromNow(-3), 24_310, 'full');
  pay('active', 'deposit', 3000, 'cash', hoursFromNow(-3));

  // Overdue: due back 6 hours ago.
  reschedule('overdue', hoursFromNow(-30));
  transition('overdue', 'confirmed');
  handover('overdue', 'pickup', hoursFromNow(-30), 41_020, 'full');
  pay('overdue', 'rent', 3500, 'upi', hoursFromNow(-30));

  // Returned two days ago with ₹1,500 still to pay.
  reschedule('returned', hoursFromNow(-72));
  transition('returned', 'confirmed');
  handover('returned', 'pickup', hoursFromNow(-72), 18_400, 'full');
  handover('returned', 'return', hoursFromNow(-49), 18_655, 'three_quarter');
  pay('returned', 'rent', 1000, 'cash', hoursFromNow(-72));

  // Closed last week, fully settled.
  reschedule('closed', hoursFromNow(-8 * 24));
  transition('closed', 'confirmed');
  handover('closed', 'pickup', hoursFromNow(-8 * 24), 52_100, 'full');
  handover('closed', 'return', hoursFromNow(-7 * 24), 52_390, 'full');
  pay('closed', 'rent', 2500, 'upi', hoursFromNow(-8 * 24));
  pay('closed', 'deposit', 3000, 'cash', hoursFromNow(-8 * 24));
  pay('closed', 'deposit_refund', 3000, 'cash', hoursFromNow(-7 * 24), 'Car returned in good condition.');
  tx(() => recomputeLedger(ctx, made.closed.id));
  transition('closed', 'closed');

  // Tata Nexon (New) is in for a service tomorrow and the day after.
  tx(() =>
    insertRow(ctx, 'maintenance_windows', {
      car_id: carId('tata-nexon-new'),
      starts_at: istAt(1, '08:00'),
      ends_at: istAt(2, '20:00'),
      reason: 'service',
      notes: 'Periodic service',
    }),
  );

  // Today's customer has sent a licence photo that is waiting to be checked.
  await addDocument(ctx, 'customer', booking('pickupToday').customer_id, 'dl_front', { docNumber: 'TS0920170045678', filename: 'licence-front.png', rgb: [90, 120, 180] });

  const result = {} as Record<DemoScenario, DemoBooking>;
  for (const p of plans) {
    result[p.key] = { code: made[p.key].code, car: p.car, customer: { name: p.customer.name, phone: p.customer.phone } };
  }
  const cars = Object.fromEntries(all<{ slug: string; id: string }>('SELECT slug, id FROM cars ORDER BY sort_order').map((c) => [c.slug, c.id]));
  return { manager: { email: managerEmail, name: 'Meena Rao' }, staff: { email: staffEmail, name: 'Sanjay Kumar' }, bookings: result, cars };
}
