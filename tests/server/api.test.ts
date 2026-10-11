// The assembled service over HTTP: data API policies, embeds, writes, sign-in with two-step,
// lockout and password reset.
import { beforeAll, describe, expect, it } from 'vitest';
import { addDaysIso, istDateIso } from '../../shared/time.ts';
import { createSession, upgradeSession } from '../../server/auth/sessions.ts';
import { createAuthToken } from '../../server/auth/tokens.ts';
import { decryptSecret } from '../../server/auth/crypto.ts';
import { totpCode } from '../../server/auth/totp.ts';
import { createApp } from '../../server/app.ts';
import { createOwner } from '../../server/boot.ts';
import { one, run, uuid } from '../../server/db/connection.ts';
import { addStaff, carId, createTestDb, type TestUser } from './harness.ts';

let app: ReturnType<typeof createApp>;
const H = { 'content-type': 'application/json', 'x-ksr-request': '1' };

async function call(path: string, body: unknown, cookie?: string, headers: Record<string, string> = H) {
  const res = await app.request(path, { method: 'POST', headers: { ...headers, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, setCookie: res.headers.get('set-cookie') };
}

const query = (q: Record<string, unknown>, cookie?: string) => call('/api/query', q, cookie);
const rpc = (name: string, args: Record<string, unknown>, cookie?: string) => call(`/api/rpc/${name}`, args, cookie);

function sessionCookie(user: TestUser, aal: 'aal1' | 'aal2' = 'aal2') {
  const s = createSession(user.id, null, 'vitest');
  if (aal === 'aal2') upgradeSession(s.id);
  return `ksr_session=${s.token}`;
}

const cookieFrom = (setCookie: string | null) => setCookie!.split(';')[0];

let codeSeq = 100;

/** Insert a customer + booking directly, pickup `hours` from now. */
function rawBooking(slug: string, hours: number, status = 'confirmed') {
  const customer = uuid();
  const phone = `+919${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
  run('INSERT INTO customers (id, full_name, phone) VALUES (?, ?, ?)', customer, 'Sita Devi', phone);
  const id = uuid();
  const pickup = new Date(Date.now() + hours * 3_600_000).toISOString();
  const ret = new Date(Date.now() + (hours + 12) * 3_600_000).toISOString();
  run(
    `INSERT INTO bookings (id, booking_code, customer_id, car_id, package, pickup_at, return_due_at, hold_until, status, price_quoted_paise)
     VALUES (?, ?, ?, ?, '12h', ?, ?, ?, ?, 150000)`,
    id,
    `KSR-${istDateIso().slice(2).replaceAll('-', '')}-${(codeSeq += 1)}`,
    customer,
    carId(slug),
    pickup,
    ret,
    ret,
    status,
  );
  return { id, customer };
}

beforeAll(() => {
  createTestDb();
  app = createApp();
});

describe('visitors', () => {
  it('read the public views only, without internal columns', async () => {
    const r = await query({ table: 'public_cars', action: 'select', select: '*', order: [{ column: 'sort_order' }] });
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(11);
    expect(r.body.data[0]).toMatchObject({ slug: 'kia-sonet', price_12h_paise: 180000, photos: [] });
    expect(Object.keys(r.body.data[0])).not.toContain('registration_number');
    const settings = await query({ table: 'public_settings', action: 'select', select: 'key, value' });
    expect(settings.body.data.map((s: { key: string }) => s.key).sort()).toEqual(['booking_rules', 'business']);
    expect(settings.body.data.find((s: { key: string }) => s.key === 'business').value.hours.mon.closed).toBe(false);
  });

  it('are refused everything else', async () => {
    expect((await query({ table: 'customers', action: 'select' })).status).toBe(401);
    expect((await query({ table: 'bookings', action: 'select' })).status).toBe(401);
    expect((await query({ table: 'public_cars', action: 'delete', filters: [{ op: 'eq', column: 'slug', value: 'kia-sonet' }] })).status).toBe(401);
    expect((await rpc('my_access', {})).status).toBe(401);
  });

  it('need the CSRF header for any write', async () => {
    const r = await call('/api/query', { table: 'public_cars', action: 'select' }, undefined, { 'content-type': 'application/json' });
    expect(r.status).toBe(403);
  });

  it('can call public RPCs', async () => {
    const r = await rpc('current_notice_version', { p_locale: 'en' });
    expect(r.body).toBe('privacy-en-v1');
  });
});

describe('sign-in with two-step verification (ADM-03)', () => {
  it('owner signs in, sees nothing until two-step, then everything', async () => {
    await createOwner('owner@ksr.test', 'Owner', 'correct horse battery');
    const bad = await call('/api/auth/login', { email: 'owner@ksr.test', password: 'wrong password!' });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toBe('Email or password is not right.');

    const login = await call('/api/auth/login', { email: 'OWNER@ksr.test', password: 'correct horse battery' });
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({ aal: 'aal1', mfa_enrolled: false, access: { role: 'owner', effective_role: null, mfa_required: true } });
    const cookie = cookieFrom(login.setCookie);
    expect(login.setCookie).toMatch(/HttpOnly/i);

    const before = await query({ table: 'cars', action: 'select', select: 'id' }, cookie);
    expect(before.body.data).toEqual([]);

    const enrol = await call('/api/auth/mfa/enroll', {}, cookie);
    expect(enrol.body.qr).toMatch(/^data:image\/png;base64,/);
    const wrong = await call('/api/auth/mfa/verify', { code: '000000' }, cookie);
    expect(wrong.status).toBe(400);
    const pending = one<{ totp_pending_secret: string }>("SELECT totp_pending_secret FROM users WHERE email = 'owner@ksr.test'")!;
    const ok = await call('/api/auth/mfa/verify', { code: totpCode(decryptSecret(pending.totp_pending_secret)) }, cookie);
    expect(ok.body).toMatchObject({ aal: 'aal2', mfa_enrolled: true, access: { effective_role: 'owner' } });

    const after = await query({ table: 'cars', action: 'select', select: 'id', count: 'exact', head: true }, cookie);
    expect(after.body).toEqual({ data: null, count: 11 });
    const audit = one<{ n: number }>("SELECT count(*) AS n FROM audit_logs WHERE action IN ('auth.login', 'auth.login_failed', 'auth.mfa_enrolled')")!;
    expect(audit.n).toBe(3);

    const out = await call('/api/auth/logout', {}, cookie);
    expect(out.status).toBe(200);
    const session = await app.request('/api/auth/session', { headers: { cookie } });
    expect(await session.json()).toEqual({ user: null });
  });

  it('locks an account after 5 failed passwords (ADM-06)', async () => {
    await call('/api/auth/login', { email: 'nobody@ksr.test', password: 'x' });
    const staff = addStaff('staff', 'locky');
    run("UPDATE users SET password_hash = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA' WHERE id = ?", staff.id);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await call('/api/auth/login', { email: staff.email, password: 'wrong-password-' + i })).status);
    expect(statuses).toEqual([400, 400, 400, 400, 429, 429]);
    expect(one<{ n: number }>("SELECT count(*) AS n FROM outbox WHERE kind = 'lockout'")!.n).toBe(1);
  });

  it('sets a password from an invite link and signs in', async () => {
    const staff = addStaff('staff', 'invited');
    const token = createAuthToken(staff.id, 'invite');
    const peek = await app.request(`/api/auth/password/token?token=${token}`);
    expect(await peek.json()).toMatchObject({ valid: true, kind: 'invite' });
    const short = await call('/api/auth/password/reset', { token, password: 'short' });
    expect(short.status).toBe(400);
    const set = await call('/api/auth/password/reset', { token, password: 'a long enough password' });
    expect(set.status).toBe(200);
    expect(set.body.access.effective_role).toBe('staff');
    const again = await call('/api/auth/password/reset', { token, password: 'a long enough password' });
    expect(again.status).toBe(410);
    const login = await call('/api/auth/login', { email: staff.email, password: 'a long enough password' });
    expect(login.status).toBe(200);
  });
});

describe('data API policies', () => {
  let owner: TestUser;
  let manager: TestUser;
  let staff: TestUser;

  beforeAll(() => {
    owner = addStaff('owner', 'o2');
    manager = addStaff('manager');
    staff = addStaff('staff');
  });

  it('staff see today ± 1 day, and customers only for today, also inside embeds (AC-10)', async () => {
    const today = rawBooking('toyota-glanza', 1);
    const tomorrow = rawBooking('hyundai-i20', 20);
    const nextWeek = rawBooking('maruti-baleno', 24 * 7);
    const sel = '*, car:cars(id, display_name), customer:customers(id, full_name)';
    const r = await query({ table: 'bookings', action: 'select', select: sel, filters: [{ op: 'in', column: 'id', value: [today.id, tomorrow.id, nextWeek.id] }] }, sessionCookie(staff, 'aal1'));
    const byId = Object.fromEntries(r.body.data.map((b: { id: string }) => [b.id, b]));
    expect(Object.keys(byId).sort()).toEqual([today.id, tomorrow.id].sort());
    expect(byId[today.id].customer).toMatchObject({ full_name: 'Sita Devi' });
    expect(byId[today.id].car).toMatchObject({ display_name: 'Toyota Glanza' });
    if (istDateIso(new Date(Date.now() + 20 * 3_600_000)) !== istDateIso()) expect(byId[tomorrow.id].customer).toBeNull();

    const customers = await query({ table: 'customers', action: 'select', select: 'id', filters: [{ op: 'in', column: 'id', value: [today.customer, nextWeek.customer] }] }, sessionCookie(staff, 'aal1'));
    expect(customers.body.data.map((c: { id: string }) => c.id)).toEqual([today.customer]);

    const asManager = await query({ table: 'customers', action: 'select', select: 'id', filters: [{ op: 'in', column: 'id', value: [today.customer, nextWeek.customer] }] }, sessionCookie(manager));
    expect(asManager.body.data).toHaveLength(2);
  });

  it('supports or-trees, not, order with nulls and embedded one-to-many', async () => {
    const cookie = sessionCookie(owner);
    const r = await query(
      {
        table: 'cars',
        action: 'select',
        select: 'slug, price_12h_paise',
        filters: [
          { op: 'or', logic: 'and(category.eq.mpv,fuel.eq.cng),slug.ilike."*baleno*"' },
          { op: 'not', column: 'status', notOp: 'in', value: '(inactive)' },
        ],
        order: [{ column: 'slug', ascending: false }],
      },
      cookie,
    );
    expect(r.body.data.map((c: { slug: string }) => c.slug)).toEqual(['maruti-xl6-cng', 'maruti-baleno']);
    const b = rawBooking('maruti-ertiga', 2);
    run(`INSERT INTO booking_events (id, booking_id, kind, note) VALUES (?, ?, 'note', 'hello')`, uuid(), b.id);
    const withEvents = await query({ table: 'bookings', action: 'select', select: 'id, booking_events(note)', filters: [{ op: 'eq', column: 'id', value: b.id }] }, cookie);
    expect(withEvents.body.data[0].booking_events).toEqual([{ note: 'hello' }]);
  });

  it('writes go through the table rules and are audited', async () => {
    const id = carId('kia-sonet');
    const staffTry = await query({ table: 'cars', action: 'update', values: { price_12h_paise: 1 }, filters: [{ op: 'eq', column: 'id', value: id }] }, sessionCookie(staff, 'aal1'));
    expect(staffTry.status).toBe(403);
    const upd = await query({ table: 'cars', action: 'update', values: { price_12h_paise: 200000 }, filters: [{ op: 'eq', column: 'id', value: id }], select: 'price_12h_paise' }, sessionCookie(manager));
    expect(upd.body.data).toEqual([{ price_12h_paise: 200000 }]);
    expect(one<{ n: number }>('SELECT count(*) AS n FROM car_price_history WHERE car_id = ?', id)!.n).toBe(2);
    const audit = one<{ before: string; after: string; actor_id: string }>("SELECT before, after, actor_id FROM audit_logs WHERE action = 'cars.update' AND entity_id = ?", id)!;
    expect(JSON.parse(audit.after)).toEqual({ price_12h_paise: 200000 });
    expect(audit.actor_id).toBe(manager.id);

    const del = await query({ table: 'cars', action: 'delete', filters: [{ op: 'eq', column: 'id', value: id }] }, sessionCookie(manager));
    expect(del.status).toBe(403);
    const noFilter = await query({ table: 'cars', action: 'update', values: { badge: 'x' } }, sessionCookie(owner));
    expect(noFilter.status).toBe(400);
    const unknown = await query({ table: 'users', action: 'select' }, sessionCookie(owner));
    expect(unknown.status).toBe(404);
  });

  it('settings upsert is Owner only and sets updated_by', async () => {
    const value = { requests_days: 60, audit_days: 400, soft_delete_days: 30 };
    const m = await query({ table: 'settings', action: 'upsert', values: { key: 'retention', value }, select: 'key' }, sessionCookie(manager));
    expect(m.status).toBe(403);
    const o = await query({ table: 'settings', action: 'upsert', values: { key: 'retention', value }, select: 'key' }, sessionCookie(owner));
    expect(o.body.data).toEqual([{ key: 'retention' }]);
    expect(one<{ updated_by: string }>("SELECT updated_by FROM settings WHERE key = 'retention'")!.updated_by).toBe(owner.id);
  });

  it('only the Owner reads the audit log', async () => {
    const m = await query({ table: 'audit_logs', action: 'select', select: 'id', limit: 1 }, sessionCookie(manager));
    expect(m.body.data).toEqual([]);
    const o = await query({ table: 'audit_logs', action: 'select', select: 'id', limit: 1 }, sessionCookie(owner));
    expect(o.body.data).toHaveLength(1);
  });

  it('dates in filters are compared as IST-safe ISO timestamps', async () => {
    const from = new Date(`${addDaysIso(istDateIso(), -1)}T00:00:00+05:30`).toISOString().replace('.000Z', 'Z');
    const r = await query({ table: 'bookings', action: 'select', select: 'id', filters: [{ op: 'gte', column: 'pickup_at', value: from }], count: 'exact', head: true }, sessionCookie(owner));
    expect(r.body.count).toBeGreaterThan(0);
  });
});
