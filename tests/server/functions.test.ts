// /api/fn/* (the former edge functions), signed document links, car photo storage, the
// outbox drain and backups, over HTTP on a fresh database with files in a temporary folder.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { addDaysIso, istDateIso } from '../../shared/time.ts';
import type { AppEnv } from '../../server/http.ts';
import type { TestUser } from './harness.ts';

// The data directory (files, backups, app secret) must be set before any server module
// reads server/config.ts, so everything from server/ is imported dynamically below.
const dataDir = mkdtempSync(join(tmpdir(), 'ksr-fn-test-'));
process.env.DATA_DIR = dataDir;
process.env.SMTP_HOST = '';
process.env.RUN_JOBS = 'false';
process.env.SITE_URL = 'https://ksr.test';

const { Hono: HonoApp } = await import('hono');
const { contextMiddleware, csrfGuard, errorResponse } = await import('../../server/http.ts');
const { functionRoutes } = await import('../../server/routes/functions.ts');
const { fileRoutes, signDocumentLink } = await import('../../server/routes/files.ts');
const { createSession, upgradeSession } = await import('../../server/auth/sessions.ts');
const { signPayload } = await import('../../server/auth/crypto.ts');
const { getDb, one, run, scalar, uuid } = await import('../../server/db/connection.ts');
const { addStaff, carId, createTestDb } = await import('./harness.ts');
const { config } = await import('../../server/config.ts');
const { drainOutbox, messageText } = await import('../../server/notify.ts');
const { enqueueEmail } = await import('../../server/outbox.ts');
const { fileExists, isValidStoragePath, saveFile } = await import('../../server/storage.ts');
const { backupDatabase, isDue, JOBS } = await import('../../server/jobs/scheduler.ts');

let app: Hono<AppEnv>;
let owner: TestUser;
let manager: TestUser;
let staff: TestUser;
let ownerCookie: string;
let managerCookie: string;
let staffCookie: string;

function sessionCookie(user: TestUser, aal: 'aal1' | 'aal2' = 'aal2') {
  const s = createSession(user.id, null, 'vitest');
  if (aal === 'aal2') upgradeSession(s.id);
  return `ksr_session=${s.token}`;
}

interface RequestOptions {
  json?: unknown;
  form?: FormData;
  raw?: Uint8Array;
  cookie?: string;
  headers?: Record<string, string>;
  /** Leave out the X-KSR-Request header. */
  noCsrf?: boolean;
}

function send(method: string, path: string, o: RequestOptions = {}) {
  const headers: Record<string, string> = { ...(o.noCsrf ? {} : { 'x-ksr-request': '1' }), ...(o.cookie ? { cookie: o.cookie } : {}), ...o.headers };
  let body: RequestInit['body'];
  if (o.form) body = o.form;
  else if (o.raw) body = o.raw as Uint8Array<ArrayBuffer>;
  else if (o.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(o.json);
  }
  return app.request(path, { method, headers, body });
}

async function fn(name: string, body: unknown, cookie?: string, headers?: Record<string, string>) {
  const res = await send('POST', `/api/fn/${name}`, { json: body, cookie, headers });
  return { status: res.status, body: (await res.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function fnForm(name: string, form: FormData, cookie?: string) {
  const res = await send('POST', `/api/fn/${name}`, { form, cookie });
  return { status: res.status, body: (await res.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

// ------------------------------------------------------------------ test files
const pad = (head: number[]) => new Uint8Array([...head, ...Array.from({ length: 200 }, (_, i) => (i * 7) % 256)]);
const ascii = (s: string) => [...s].map((ch) => ch.charCodeAt(0));
const pdfBytes = (seed = 'a') => pad([...ascii('%PDF-1.4\n'), ...ascii(seed)]);
const jpegBytes = (seed = 1) => pad([0xff, 0xd8, 0xff, 0xe0, seed]);
const webpBytes = (seed = 1) => pad([...ascii('RIFF'), 0x40, 0, 0, 0, ...ascii('WEBPVP8 '), seed]);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fileOf = (bytes: Uint8Array, name: string, type: string) => new File([bytes as Uint8Array<ArrayBuffer>], name, { type });

function uploadForm(fields: Record<string, string>, bytes: Uint8Array, name: string, type: string, shaOverride?: string) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  form.set('file', fileOf(bytes, name, type));
  form.set('sha256', shaOverride ?? sha(bytes));
  return form;
}

// ------------------------------------------------------------------ data helpers
let codeSeq = 500;
function rawCustomer(name = 'Sita Devi'): string {
  const id = uuid();
  const phone = `+919${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
  run('INSERT INTO customers (id, full_name, phone) VALUES (?, ?, ?)', id, name, phone);
  return id;
}

function rawBooking(customerId: string, slug: string, pickupIso: string, hours: number, status: string): string {
  const id = uuid();
  const ret = new Date(Date.parse(pickupIso) + hours * 3_600_000).toISOString();
  run(
    `INSERT INTO bookings (id, booking_code, customer_id, car_id, package, pickup_at, return_due_at, hold_until, status, price_quoted_paise)
     VALUES (?, ?, ?, ?, '12h', ?, ?, ?, ?, 150000)`,
    id,
    `KSR-${istDateIso().slice(2).replaceAll('-', '')}-${(codeSeq += 1)}`,
    customerId,
    carId(slug),
    pickupIso,
    ret,
    ret,
    status,
  );
  return id;
}

const tomorrowAt = (time: string) => ({ date: addDaysIso(istDateIso(), 1), time });

beforeAll(() => {
  createTestDb();
  app = new HonoApp<AppEnv>();
  app.onError((e, c) => errorResponse(c, e));
  app.use('/api/*', contextMiddleware);
  app.use('/api/*', csrfGuard);
  app.route('/api/fn', functionRoutes);
  app.route('/', fileRoutes);

  owner = addStaff('owner', 'owner');
  manager = addStaff('manager', 'manager');
  staff = addStaff('staff', 'staff');
  ownerCookie = sessionCookie(owner);
  managerCookie = sessionCookie(manager);
  staffCookie = sessionCookie(staff, 'aal1'); // two-step isn't required for Staff by default
});

afterAll(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows may still hold a handle; the OS cleans the temp folder eventually.
  }
});

// ================================================================== submit-booking
describe('submit-booking', () => {
  const valid = (overrides: Record<string, unknown> = {}) => {
    const t = tomorrowAt('10:00');
    return {
      car_id: carId('kia-sonet'),
      package: '12h',
      pickup_date: t.date,
      pickup_time: t.time,
      full_name: 'Ravi Kumar',
      phone: '98765 43210',
      dl_number: 'TS0920110012345',
      email: '',
      consent: true,
      website: '',
      locale: 'en',
      ...overrides,
    };
  };

  it('needs the X-KSR-Request header (CSRF)', async () => {
    const res = await send('POST', '/api/fn/submit-booking', { json: valid(), noCsrf: true });
    expect(res.status).toBe(403);
  });

  it('pretends to accept honeypot submissions and saves nothing', async () => {
    const before = scalar<number>('SELECT count(*) FROM submission_attempts');
    const r = await fn('submit-booking', valid({ website: 'https://spam.example' }));
    expect(r).toEqual({ status: 200, body: { ok: true, booking_code: null } });
    expect(scalar<number>('SELECT count(*) FROM submission_attempts')).toBe(before);
    expect(scalar<number>('SELECT count(*) FROM bookings')).toBe(0);
  });

  it('returns 422 with a message per field', async () => {
    const r = await fn('submit-booking', valid({ phone: '12345', consent: false, package: '6h', full_name: '' }));
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('validation');
    expect(r.body.error).toBe('Check the highlighted fields.');
    expect(Object.keys(r.body.hint).sort()).toEqual(['consent', 'full_name', 'package', 'phone']);
  });

  it('rejects JSON that is not an object', async () => {
    const res = await send('POST', '/api/fn/submit-booking', { raw: new TextEncoder().encode('[1,2]'), headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('bad_request');
  });

  // Depends on server/rpc/booking.ts createBooking.
  it('creates a booking request', async () => {
    const r = await fn('submit-booking', valid(), undefined, { 'x-forwarded-for': '198.51.100.1' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, phone: '+919876543210', price_paise: 180000 });
    expect(r.body.booking_code).toMatch(/^KSR-\d{6}-\d{3,}$/);
    expect(r.body.pickup_at).toBe(new Date(`${tomorrowAt('10:00').date}T10:00:00+05:30`).toISOString());
    expect(Date.parse(r.body.return_due_at) - Date.parse(r.body.pickup_at)).toBe(12 * 3_600_000);
    expect(scalar('SELECT status FROM bookings WHERE booking_code = ?', r.body.booking_code)).toBe('requested');
  });

  // Depends on server/rpc/booking.ts (website requests refuse clashes and suggest other cars).
  it('answers a clash with suggestions instead of an error', async () => {
    const t = tomorrowAt('14:00');
    rawBooking(rawCustomer('Clash Holder'), 'toyota-glanza', new Date(`${t.date}T${t.time}:00+05:30`).toISOString(), 12, 'confirmed');
    const r = await fn('submit-booking', valid({ car_id: carId('toyota-glanza'), pickup_time: t.time, phone: '9123456780' }), undefined, {
      'x-forwarded-for': '198.51.100.2',
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: false, error: 'clash' });
    expect(typeof r.body.message).toBe('string');
    expect(Array.isArray(r.body.suggestions)).toBe(true);
  });

  // Depends on server/rpc/booking.ts reporting field errors with the field name as the code.
  it('maps booking-logic field errors to 422', async () => {
    const r = await fn('submit-booking', valid({ car_id: randomUUID(), phone: '9000000001' }), undefined, { 'x-forwarded-for': '198.51.100.3' });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('validation');
    expect(r.body.hint).toHaveProperty('car_id');
  });

  it('allows 5 requests per mobile number an hour; the 6th gets 429', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await fn('submit-booking', valid({ phone: '9988776655' }), undefined, { 'x-forwarded-for': `203.0.113.${100 + i}` });
      statuses.push(r.status);
      if (i === 5) expect(r.body).toEqual({ error: 'Too many requests. Please call us.', code: 'rate_limited' });
    }
    expect(statuses.slice(0, 5)).not.toContain(429);
    expect(statuses[5]).toBe(429);
  });

  it('answers 405 for the wrong method and 404 for unknown functions', async () => {
    expect((await send('GET', '/api/fn/submit-booking')).status).toBe(405);
    expect((await send('POST', '/api/fn/nope', { json: {} })).status).toBe(404);
  });
});

// ================================================================== documents (depend on server/rpc/documents.ts)
describe('document-upload, document-view-url and /api/files', () => {
  let insuranceId: string;
  const insurance = pdfBytes('insurance');

  it('needs a signed-in admin', async () => {
    const form = uploadForm({ owner_type: 'car', owner_id: carId('kia-sonet'), doc_type: 'insurance', expiry_date: '2027-03-31' }, insurance, 'Insurance.pdf', 'application/pdf');
    expect((await fnForm('document-upload', form)).status).toBe(401);
    const aal1 = await fnForm('document-upload', form, sessionCookie(manager, 'aal1'));
    expect(aal1.status).toBe(403);
    expect(aal1.body.code).toBe('mfa_required');
  });

  it('uploads into the private store under the 6.8.3 layout', async () => {
    const car = carId('kia-sonet');
    const form = uploadForm({ owner_type: 'car', owner_id: car, doc_type: 'insurance', expiry_date: '2027-03-31', doc_number: 'POL 1234 5678' }, insurance, 'Insurance 2026 – Kia.pdf', 'application/pdf');
    const r = await fnForm('document-upload', form, ownerCookie);
    expect(r.status).toBe(200);
    expect(r.body.duplicates).toEqual([]);
    const doc = r.body.document;
    insuranceId = doc.id;
    expect(doc).toMatchObject({ owner_type: 'car', car_id: car, doc_type: 'insurance', mime_type: 'application/pdf', size_bytes: insurance.length, sha256: sha(insurance) });
    expect(doc.original_filename).toBe('Insurance 2026 – Kia.pdf');
    expect(doc.storage_path).toMatch(new RegExp(`^vehicles/${car}/insurance/[0-9a-f-]{36}\\.pdf$`));
    expect(existsSync(join(config.filesDir, 'documents', ...doc.storage_path.split('/')))).toBe(true);
    expect(scalar('SELECT count(*) FROM audit_logs WHERE action = ? AND entity_id = ?', 'document.upload', doc.id)).toBe(1);
  });

  it('refuses the same file again for the same owner and type (409)', async () => {
    const form = uploadForm({ owner_type: 'car', owner_id: carId('kia-sonet'), doc_type: 'insurance', expiry_date: '2027-03-31' }, insurance, 'again.pdf', 'application/pdf');
    const r = await fnForm('document-upload', form, ownerCookie);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'duplicate', hint: { document_id: insuranceId } });
  });

  it('checks the fingerprint, the real file type and the owner permission', async () => {
    const fields = { owner_type: 'car', owner_id: carId('toyota-glanza'), doc_type: 'puc', expiry_date: '2027-01-01' };
    const mismatch = await fnForm('document-upload', uploadForm(fields, pdfBytes('x'), 'puc.pdf', 'application/pdf', 'a'.repeat(64)), ownerCookie);
    expect(mismatch).toMatchObject({ status: 400, body: { code: 'checksum_mismatch' } });

    const text = new TextEncoder().encode('just some text pretending to be a PDF document');
    const wrongType = await fnForm('document-upload', uploadForm(fields, text, 'puc.pdf', 'application/pdf'), ownerCookie);
    expect(wrongType).toMatchObject({ status: 415, body: { code: 'unsupported_type', error: 'Upload a JPG, PNG, WebP or PDF file.' } });

    // Staff can't upload vehicle papers.
    const forbidden = await fnForm('document-upload', uploadForm(fields, pdfBytes('y'), 'puc.pdf', 'application/pdf'), staffCookie);
    expect(forbidden).toMatchObject({ status: 403, body: { error: "You can't upload this document here." } });

    const badOwner = await fnForm('document-upload', uploadForm({ ...fields, owner_type: 'planet' }, pdfBytes('z'), 'puc.pdf', 'application/pdf'), ownerCookie);
    expect(badOwner).toMatchObject({ status: 422, body: { code: 'validation', hint: { owner_type: expect.any(String) } } });
  });

  it('issues a logged 5-minute link that serves the file', async () => {
    const r = await fn('document-view-url', { document_id: insuranceId }, ownerCookie);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ filename: 'Insurance 2026 – Kia.pdf', mime_type: 'application/pdf', watermark: null });
    expect(r.body.url).toMatch(/^\/api\/files\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const ttl = Date.parse(r.body.expires_at) - Date.now();
    expect(ttl).toBeGreaterThan(290_000);
    expect(ttl).toBeLessThanOrEqual(300_000);
    expect(scalar('SELECT count(*) FROM audit_logs WHERE action = ? AND entity_id = ?', 'document.view', insuranceId)).toBe(1);

    const file = await send('GET', r.body.url);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('application/pdf');
    expect(file.headers.get('cache-control')).toBe('private, no-store');
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
    expect(file.headers.get('content-disposition')).toBe(
      `inline; filename="Insurance 2026 _ Kia.pdf"; filename*=UTF-8''${encodeURIComponent('Insurance 2026 – Kia.pdf')}`,
    );
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(insurance);

    const dl = await fn('document-view-url', { document_id: insuranceId, download: true }, managerCookie);
    expect(dl.status).toBe(200);
    expect(scalar('SELECT count(*) FROM audit_logs WHERE action = ? AND entity_id = ?', 'document.download', insuranceId)).toBe(1);
    const attachment = await send('GET', dl.body.url);
    expect(attachment.headers.get('content-disposition')).toMatch(/^attachment; /);
    await attachment.arrayBuffer();
  });

  it('refuses expired, forged and erased links', async () => {
    const expired = signPayload({ d: insuranceId, e: Math.floor(Date.now() / 1000) - 1, dl: 0 });
    const r410 = await send('GET', `/api/files/${expired}`);
    expect(r410.status).toBe(410);

    const good = signDocumentLink(insuranceId, false).url;
    const [payload, signature] = good.split('.');
    const flipped = signature.slice(0, 10) + (signature[10] === 'A' ? 'B' : 'A') + signature.slice(11);
    expect((await send('GET', `${payload}.${flipped}`)).status).toBe(403);
    const tampered = signPayload({ d: insuranceId, e: Math.floor(Date.now() / 1000) + 3600, dl: 1 }).split('.')[0] + '.' + signature;
    expect((await send('GET', `/api/files/${tampered}`)).status).toBe(403);
    expect((await send('GET', '/api/files/not-a-token')).status).toBe(403);

    const gone = signDocumentLink(randomUUID(), false).url;
    expect((await send('GET', gone)).status).toBe(404);
  });

  it('returns 404 for unknown documents', async () => {
    const r = await fn('document-view-url', { document_id: randomUUID() }, ownerCookie);
    expect(r).toMatchObject({ status: 404, body: { error: 'Document not found.', code: 'not_found' } });
    expect((await fn('document-view-url', {}, ownerCookie)).status).toBe(404);
  });

  it("lets Staff view today's customer KYC but not download it", async () => {
    const customer = rawCustomer('Lakshmi Rao');
    rawBooking(customer, 'hyundai-i20', new Date(Date.now() - 3_600_000).toISOString(), 12, 'active');
    const dl = jpegBytes(7);
    const up = await fnForm('document-upload', uploadForm({ owner_type: 'customer', owner_id: customer, doc_type: 'dl_front' }, dl, 'licence.jpeg', 'image/jpeg'), ownerCookie);
    expect(up.status).toBe(200);
    expect(up.body.document.storage_path).toMatch(new RegExp(`^customers/${customer}/dl_front/[0-9a-f-]{36}\\.jpg$`));

    const download = await fn('document-view-url', { document_id: up.body.document.id, download: true }, staffCookie);
    expect(download).toMatchObject({ status: 403, body: { error: "You can't download this document. You can view it in the app.", code: 'forbidden' } });

    const view = await fn('document-view-url', { document_id: up.body.document.id }, staffCookie);
    expect(view.status).toBe(200);
    expect(view.body.watermark).toMatch(/^KSR Self Drive Cars — for rental verification only — \d{2} [A-Z][a-z]{2} \d{4}$/);
    const file = await send('GET', view.body.url);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/jpeg');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(dl);
  });
});

// ================================================================== car photos
describe('car photo storage', () => {
  const car = () => carId('maruti-baleno');
  const photoId = randomUUID();
  const full = () => `cars/${car()}/${photoId}.webp`;
  const medium = () => `cars/${car()}/${photoId}-800.webp`;
  const put = (path: string, cookie: string | undefined, bytes = webpBytes(), type = 'image/webp', noCsrf = false) =>
    send('PUT', `/api/storage/car-photos/${path}`, { raw: bytes, cookie, headers: { 'content-type': type }, noCsrf });

  it('lets only an Owner or Manager upload', async () => {
    expect((await put(full(), undefined)).status).toBe(401);
    expect((await put(full(), staffCookie)).status).toBe(403);
    const aal1 = await put(full(), sessionCookie(manager, 'aal1'));
    expect(aal1.status).toBe(403);
    expect((await put(full(), ownerCookie, webpBytes(), 'image/webp', true)).status).toBe(403); // no CSRF header
  });

  it('checks the path, the declared type and the real content', async () => {
    expect((await put(`cars/${car()}/../../x.webp`, ownerCookie)).status).toBe(400);
    expect((await put(`cars/${car()}/${photoId}.png`, ownerCookie)).status).toBe(400);
    expect((await put(`cars/not-a-car/${photoId}.webp`, ownerCookie)).status).toBe(400);
    expect((await put(`cars/${randomUUID()}/${photoId}.webp`, ownerCookie)).status).toBe(404);
    expect((await put(full(), ownerCookie, webpBytes(), 'image/png')).status).toBe(415);
    expect((await put(full(), ownerCookie, jpegBytes(), 'image/webp')).status).toBe(415);
    const huge = new Uint8Array(10 * 1024 * 1024 + 1);
    huge.set(webpBytes().subarray(0, 16));
    const tooBig = await put(full(), ownerCookie, huge);
    expect(tooBig.status).toBe(413);
    expect(((await tooBig.json()) as { details: string }).details).toBe('too_large');
    expect(await fileExists('car-photos', full())).toBe(false);
  });

  it('saves new files and never overwrites', async () => {
    const r = await put(full(), ownerCookie);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ path: full(), fullPath: `car-photos/${full()}` });
    expect((await put(full(), ownerCookie, webpBytes(2))).status).toBe(409);
    expect((await put(medium(), managerCookie, webpBytes(3))).status).toBe(200);
  });

  it('serves photos publicly with long caching', async () => {
    const r = await send('GET', `/media/car-photos/${full()}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/webp');
    expect(r.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(webpBytes());
    expect((await send('GET', `/media/car-photos/cars/${car()}/${randomUUID()}.webp`)).status).toBe(404);
    expect((await send('GET', '/media/car-photos/cars/..%2F..%2Fksr.db')).status).toBe(404);
  });

  it('lets only an Owner or Manager remove photos', async () => {
    const remove = (paths: unknown, cookie?: string) => send('POST', '/api/storage/car-photos/remove', { json: { paths }, cookie });
    expect((await remove([full()])).status).toBe(401);
    expect((await remove([full()], staffCookie)).status).toBe(403);
    expect((await remove(['../ksr.db'], ownerCookie)).status).toBe(400);
    expect((await remove([], ownerCookie)).status).toBe(400);

    const r = await remove([full(), medium(), `cars/${car()}/${photoId}-400.webp`], managerCookie);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { removed: string[] }).removed).toHaveLength(3);
    expect((await send('GET', `/media/car-photos/${full()}`)).status).toBe(404);
    expect(await fileExists('car-photos', medium())).toBe(false);
  });
});

// ================================================================== customer upload links
describe('create-upload-link and customer-upload', () => {
  let customer: string;
  let token: string;

  const customerForm = (t: string, files: Record<string, Uint8Array>, extra: Record<string, string> = {}) => {
    const form = new FormData();
    form.set('token', t);
    form.set('consent', 'true');
    for (const [k, v] of Object.entries(extra)) form.set(k, v);
    for (const [field, bytes] of Object.entries(files)) form.set(field, fileOf(bytes, `${field}.jpg`, 'image/jpeg'));
    return form;
  };
  const customerFiles = () =>
    existsSync(join(config.filesDir, 'documents', 'customers', customer)) ? readdirSync(join(config.filesDir, 'documents', 'customers', customer), { recursive: true }) : [];

  async function newLink(): Promise<string> {
    const r = await fn('create-upload-link', { customer_id: customer }, ownerCookie);
    expect(r.status).toBe(200);
    return String(r.body.url).split('/upload/')[1];
  }

  it('creates a one-time link (admin only)', async () => {
    customer = rawCustomer('Anil Kumar');
    expect((await fn('create-upload-link', { customer_id: customer })).status).toBe(401);
    // Staff only reach customers with a booking today.
    expect((await fn('create-upload-link', { customer_id: customer }, staffCookie)).status).toBe(404);

    const r = await fn('create-upload-link', { customer_id: customer }, ownerCookie);
    expect(r.status).toBe(200);
    expect(r.body.url).toMatch(/^https:\/\/ksr\.test\/upload\/[A-Za-z0-9_-]{43}$/);
    expect(r.body.message).toContain(r.body.url);
    expect(r.body.message).toContain('Hi Anil');
    expect(Date.parse(r.body.expires_at) - Date.now()).toBeGreaterThan(23 * 3_600_000);
    token = r.body.url.split('/upload/')[1];
    expect(scalar('SELECT count(*) FROM audit_logs WHERE action = ? AND entity_id = ?', 'upload_link.create', customer)).toBe(1);
    // Only the hash is stored.
    expect(scalar('SELECT count(*) FROM upload_links WHERE token_hash = ?', token)).toBe(0);
  });

  it('checks a link', async () => {
    const res = await send('GET', `/api/fn/customer-upload?token=${token}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ valid: true, first_name: 'Anil', business_name: 'KSR Self Drive Cars' });
    expect((body.doc_types as Array<{ key: string }>).map((t) => t.key)).toEqual(['dl_front', 'dl_back', 'aadhaar_masked', 'other_photo_id']);
    const bad = await send('GET', `/api/fn/customer-upload?token=${'x'.repeat(43)}`);
    expect(bad.status).toBe(410);
    expect(((await bad.json()) as { code: string }).code).toBe('link_invalid');
  });

  it('checks consent, files and the Aadhaar confirmation before using the link', async () => {
    const noConsent = customerForm(token, { file_dl_front: jpegBytes(20) });
    noConsent.set('consent', 'false');
    expect((await fnForm('customer-upload', noConsent)).body.code).toBe('consent');
    expect((await fnForm('customer-upload', customerForm(token, {}))).body.code).toBe('no_files');
    expect((await fnForm('customer-upload', customerForm(token, { file_aadhaar_masked: jpegBytes(21) }))).body.code).toBe('aadhaar_mask');
    const notImage = await fnForm('customer-upload', customerForm(token, { file_dl_back: new TextEncoder().encode('definitely not a photo at all') }));
    expect(notImage.status).toBe(415);
    expect(notImage.body.error).toMatch(/^Driving licence – back: /);
    expect((await send('GET', `/api/fn/customer-upload?token=${token}`)).status).toBe(200);
  });

  it('rolls everything back when saving fails, and keeps the link usable', async () => {
    getDb().exec(`CREATE TRIGGER test_fail_documents BEFORE INSERT ON documents BEGIN SELECT RAISE(ABORT, 'invalid: Simulated failure'); END;`);
    try {
      const r = await fnForm('customer-upload', customerForm(token, { file_dl_front: jpegBytes(30), file_dl_back: jpegBytes(31) }));
      expect(r).toMatchObject({ status: 400, body: { error: 'Simulated failure', code: 'invalid' } });
    } finally {
      getDb().exec('DROP TRIGGER test_fail_documents');
    }
    expect(scalar('SELECT count(*) FROM documents WHERE customer_id = ?', customer)).toBe(0);
    expect(scalar('SELECT count(*) FROM consents WHERE customer_id = ?', customer)).toBe(0);
    expect(customerFiles().filter((f) => String(f).match(/\.(jpg|pdf|png|webp)$/))).toEqual([]);
    expect((await send('GET', `/api/fn/customer-upload?token=${token}`)).status).toBe(200);
  });

  it('saves all files as Pending, records consent, notifies, and uses up the link', async () => {
    const r = await fnForm(
      'customer-upload',
      customerForm(token, { file_dl_front: jpegBytes(40), file_aadhaar_masked: jpegBytes(41) }, { aadhaar_masked_confirmed: 'true', locale: 'en' }),
    );
    expect(r).toEqual({ status: 200, body: { ok: true, uploaded: 2 } });
    expect(scalar('SELECT count(*) FROM documents WHERE customer_id = ? AND uploaded_via = ? AND status = ?', customer, 'customer_link', 'pending')).toBe(2);
    expect(scalar('SELECT count(*) FROM consents WHERE customer_id = ? AND purpose = ? AND channel = ?', customer, 'document_upload', 'customer_link')).toBe(1);
    expect(scalar('SELECT count(*) FROM outbox WHERE kind = ?', 'customer_upload')).toBe(1);
    expect(customerFiles().filter((f) => String(f).endsWith('.jpg'))).toHaveLength(2);

    expect((await send('GET', `/api/fn/customer-upload?token=${token}`)).status).toBe(410);
    expect((await fnForm('customer-upload', customerForm(token, { file_dl_back: jpegBytes(42) }))).status).toBe(410);
  });

  it('only accepts a link once even when sent twice at the same time', async () => {
    const t = await newLink();
    const [a, b] = await Promise.all([
      fnForm('customer-upload', customerForm(t, { file_dl_back: jpegBytes(50) })),
      fnForm('customer-upload', customerForm(t, { file_dl_back: jpegBytes(51) })),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 410]);
  });
});

// ================================================================== retention-purge
describe('retention-purge', () => {
  it('is for the Owner with two-step verification', async () => {
    expect((await fn('retention-purge', {}, managerCookie)).status).toBe(403);
    const aal1 = await fn('retention-purge', {}, sessionCookie(owner, 'aal1'));
    expect(aal1).toMatchObject({ status: 403, body: { code: 'mfa_required' } });
  });

  // Depends on server/rpc/documents.ts (retentionDue, eraseDocumentRow) and server/jobs/tasks.ts.
  it('erases files and records whose time is up', async () => {
    const car = carId('maruti-ertiga');
    const id = uuid();
    const path = `vehicles/${car}/rc/${randomUUID()}.pdf`;
    const bytes = pdfBytes('old rc');
    await saveFile('documents', path, bytes);
    const past = new Date(Date.now() - 86_400_000).toISOString();
    run(
      `INSERT INTO documents (id, owner_type, car_id, doc_type, storage_path, original_filename, mime_type, size_bytes, sha256, status,
                              deleted_at, delete_reason, retain_until)
       VALUES (?, 'car', ?, 'rc', ?, 'rc.pdf', 'application/pdf', ?, ?, 'verified', ?, 'Uploaded by mistake', ?)`,
      id,
      car,
      path,
      bytes.length,
      sha(bytes),
      past,
      past,
    );
    const r = await fn('retention-purge', {}, ownerCookie);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ failed: 0 });
    expect(r.body.erased).toBeGreaterThanOrEqual(1);
    expect(r.body.batches).toBeGreaterThanOrEqual(1);
    expect(typeof r.body.stale).toBe('object');
    expect(scalar('SELECT count(*) FROM documents WHERE id = ?', id)).toBe(0);
    expect(await fileExists('documents', path)).toBe(false);
    expect(scalar('SELECT count(*) FROM audit_logs WHERE action = ? AND entity_id = ?', 'document.erase', id)).toBe(1);
  });
});

// ================================================================== admin-staff
describe('admin-staff', () => {
  it('is for the Owner with two-step verification', async () => {
    expect((await fn('admin-staff', { action: 'invite' })).status).toBe(401);
    expect((await fn('admin-staff', { action: 'invite' }, managerCookie)).body.code).toBe('forbidden');
    expect((await fn('admin-staff', { action: 'invite' }, sessionCookie(owner, 'aal1'))).body.code).toBe('mfa_required');
    expect((await fn('admin-staff', { action: 'fly' }, ownerCookie)).body.code).toBe('invalid_action');
  });

  let invitedId: string;

  it('invites: account without a password, profile, role, audit, and the link while email is off', async () => {
    const r = await fn('admin-staff', { action: 'invite', email: 'New.Person@Example.com', full_name: ' Priya  Sharma ', role: 'staff', phone: '98480 22338' }, ownerCookie);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    invitedId = r.body.user_id;
    expect(r.body.link).toMatch(/^https:\/\/ksr\.test\/admin\/reset-password\?token=[A-Za-z0-9_-]+&invite=1$/);
    expect(one('SELECT email, password_hash FROM users WHERE id = ?', invitedId)).toEqual({ email: 'new.person@example.com', password_hash: null });
    expect(one('SELECT full_name, phone, active FROM staff_profiles WHERE user_id = ?', invitedId)).toEqual({ full_name: 'Priya Sharma', phone: '+919848022338', active: 1 });
    expect(scalar('SELECT role FROM user_roles WHERE user_id = ?', invitedId)).toBe('staff');
    expect(scalar(`SELECT count(*) FROM auth_tokens WHERE user_id = ? AND kind = 'invite' AND used_at IS NULL`, invitedId)).toBe(1);
    expect(one('SELECT actor_id FROM audit_logs WHERE action = ? AND entity_id = ?', 'staff.invite', invitedId)).toEqual({ actor_id: owner.id });

    const again = await fn('admin-staff', { action: 'invite', email: 'new.person@example.COM', full_name: 'Priya', role: 'staff' }, ownerCookie);
    expect(again).toMatchObject({ status: 409, body: { code: 'exists' } });
    const bad = await fn('admin-staff', { action: 'invite', email: 'nope', full_name: 'X', role: 'staff' }, ownerCookie);
    expect(bad).toMatchObject({ status: 422, body: { code: 'validation', hint: { email: expect.any(String) } } });
    const badRole = await fn('admin-staff', { action: 'invite', email: 'a@b.co', full_name: 'X', role: 'admin' }, ownerCookie);
    expect(badRole.body.hint).toHaveProperty('role');
  });

  it('resends an invite, or a reset link once a password is set', async () => {
    const r = await fn('admin-staff', { action: 'resend_invite', user_id: invitedId }, ownerCookie);
    expect(r.status).toBe(200);
    expect(r.body.link).toMatch(/&invite=1$/);
    run(`UPDATE users SET password_hash = 'scrypt$x' WHERE id = ?`, invitedId);
    const reset = await fn('admin-staff', { action: 'resend_invite', user_id: invitedId }, ownerCookie);
    expect(reset.body.link).toMatch(/\/admin\/reset-password\?token=[A-Za-z0-9_-]+$/);
    expect(scalar(`SELECT count(*) FROM audit_logs WHERE action = 'staff.resend_invite' AND entity_id = ?`, invitedId)).toBe(2);
  });

  it('changes roles and profiles with audit entries', async () => {
    const role = await fn('admin-staff', { action: 'set_role', user_id: invitedId, role: 'manager' }, ownerCookie);
    expect(role.status).toBe(200);
    expect(scalar('SELECT role FROM user_roles WHERE user_id = ?', invitedId)).toBe('manager');
    expect(one(`SELECT before, after FROM audit_logs WHERE action = 'staff.role_change' AND entity_id = ?`, invitedId)).toEqual({
      before: '{"role":"staff"}',
      after: '{"role":"manager"}',
    });
    expect((await fn('admin-staff', { action: 'set_role', user_id: owner.id, role: 'staff' }, ownerCookie)).body.code).toBe('self');

    const profile = await fn('admin-staff', { action: 'update_profile', user_id: invitedId, full_name: 'Priya S', phone: null }, ownerCookie);
    expect(profile.status).toBe(200);
    expect(one('SELECT full_name, phone FROM staff_profiles WHERE user_id = ?', invitedId)).toEqual({ full_name: 'Priya S', phone: null });
    expect(scalar(`SELECT count(*) FROM audit_logs WHERE action = 'staff.update_profile' AND entity_id = ?`, invitedId)).toBe(1);
    expect((await fn('admin-staff', { action: 'update_profile', user_id: randomUUID() }, ownerCookie)).status).toBe(404);
  });

  it('deactivates: profile inactive, sessions ended at once; reactivates', async () => {
    const victim = addStaff('staff', 'leaver');
    const cookie = sessionCookie(victim, 'aal1');
    sessionCookie(victim, 'aal1');
    expect((await fn('document-view-url', { document_id: randomUUID() }, cookie)).status).toBe(404); // signed in

    const r = await fn('admin-staff', { action: 'deactivate', user_id: victim.id }, ownerCookie);
    expect(r).toEqual({ status: 200, body: { ok: true, user_id: victim.id } });
    expect(scalar('SELECT active FROM staff_profiles WHERE user_id = ?', victim.id)).toBe(0);
    expect(scalar('SELECT count(*) FROM sessions WHERE user_id = ?', victim.id)).toBe(0);
    expect(scalar(`SELECT count(*) FROM audit_logs WHERE action = 'staff.deactivate' AND entity_id = ?`, victim.id)).toBe(1);
    expect((await fn('document-view-url', { document_id: randomUUID() }, cookie)).status).toBe(401);
    expect((await fn('admin-staff', { action: 'resend_invite', user_id: victim.id }, ownerCookie)).body.code).toBe('inactive');

    expect((await fn('admin-staff', { action: 'deactivate', user_id: owner.id }, ownerCookie)).body.code).toBe('self');

    const back = await fn('admin-staff', { action: 'reactivate', user_id: victim.id }, ownerCookie);
    expect(back.status).toBe(200);
    expect(scalar('SELECT active FROM staff_profiles WHERE user_id = ?', victim.id)).toBe(1);
    expect(scalar(`SELECT count(*) FROM audit_logs WHERE action = 'staff.reactivate' AND entity_id = ?`, victim.id)).toBe(1);
  });

  it('lets an Owner demote or deactivate another Owner while one stays active', async () => {
    const second = addStaff('owner', 'coowner');
    expect((await fn('admin-staff', { action: 'set_role', user_id: second.id, role: 'manager' }, ownerCookie)).status).toBe(200);
    expect((await fn('admin-staff', { action: 'set_role', user_id: second.id, role: 'owner' }, ownerCookie)).status).toBe(200);
    expect((await fn('admin-staff', { action: 'deactivate', user_id: second.id }, ownerCookie)).status).toBe(200);
    expect(scalar('SELECT active FROM staff_profiles WHERE user_id = ?', owner.id)).toBe(1);
  });
});

// ================================================================== outbox drain
describe('notify', () => {
  it('marks messages skipped while SMTP is not configured', async () => {
    // Let any drainSoon() scheduled by earlier requests finish first, then start clean.
    await new Promise((resolve) => setTimeout(resolve, 400));
    run(`UPDATE outbox SET status = 'sent' WHERE status = 'pending'`);
    const id = enqueueEmail('test', ['owner@ksr.test'], 'Hello', 'Body', { path: '/admin/bookings' }, null)!;
    const waiting = enqueueEmail('test', ['owner@ksr.test'], 'Later', 'Body')!;
    run('UPDATE outbox SET next_attempt_at = ? WHERE id = ?', new Date(Date.now() + 60_000).toISOString(), waiting);
    const result = await drainOutbox(10);
    expect(result).toMatchObject({ picked: 1, skipped: 1, sent: 0, failed: 0 });
    expect(one('SELECT status, last_error, attempts FROM outbox WHERE id = ?', id)).toEqual({ status: 'skipped', last_error: 'Email is not configured', attempts: 1 });
    expect(scalar('SELECT status FROM outbox WHERE id = ?', waiting)).toBe('pending');
  });

  it('adds the admin link to the message', () => {
    expect(messageText('Body', { path: '/admin/bookings/1' })).toBe('Body\n\nOpen: https://ksr.test/admin/bookings/1');
    expect(messageText('Body', {})).toBe('Body');
  });
});

// ================================================================== storage paths, scheduler, backups
describe('storage and jobs', () => {
  it('accepts only safe relative storage paths', () => {
    expect(isValidStoragePath('customers/abc/dl_front/x.jpg')).toBe(true);
    for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a/./b', 'a//b', 'a\\b', 'C:/x', 'a b', 'a/%2e%2e/b', 'a/']) {
      expect(isValidStoragePath(bad)).toBe(false);
    }
  });

  it('runs daily jobs once per day, after their IST time, and catches up after downtime', () => {
    const job = JOBS.find((j) => j.name === 'document-expiry')!;
    const at = (iso: string) => new Date(iso);
    const ranAt = (iso: string) => ({ last_run_at: iso, last_result: '{"ok":true}' });
    // 08:00 IST = 02:30Z
    expect(isDue(job, undefined, at('2026-10-11T01:00:00Z'))).toBe(true);
    expect(isDue(job, ranAt('2026-10-10T02:31:00Z'), at('2026-10-11T02:00:00Z'))).toBe(false);
    expect(isDue(job, ranAt('2026-10-10T02:31:00Z'), at('2026-10-11T02:31:00Z'))).toBe(true);
    expect(isDue(job, ranAt('2026-10-08T02:31:00Z'), at('2026-10-11T00:00:00Z'))).toBe(true);
    expect(isDue(job, ranAt('2026-10-11T02:31:00Z'), at('2026-10-11T20:00:00Z'))).toBe(false);
    const notify = JOBS.find((j) => j.name === 'notify')!;
    expect(isDue(notify, ranAt('2026-10-11T02:00:00Z'), at('2026-10-11T02:00:30Z'))).toBe(false);
    expect(isDue(notify, ranAt('2026-10-11T02:00:00Z'), at('2026-10-11T02:01:00Z'))).toBe(true);
  });

  it('backs up the database and keeps the newest 14 copies', () => {
    const dir = join(dataDir, 'backups-test');
    for (let d = 1; d <= 20; d++) {
      const day = `2026-09-${String(d).padStart(2, '0')}`;
      if (d === 1) backupDatabase(new Date(`${day}T06:00:00Z`), dir);
      else writeFileSync(join(dir, `ksr-${day}.db`), 'old');
    }
    const result = backupDatabase(new Date('2026-10-11T06:00:00Z'), dir);
    expect(result.file).toBe('ksr-2026-10-11.db');
    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(14);
    expect(files.at(-1)).toBe('ksr-2026-10-11.db');
    expect(files[0]).toBe('ksr-2026-09-08.db');
    // Running twice on one day replaces that day's copy.
    expect(backupDatabase(new Date('2026-10-11T07:00:00Z'), dir).file).toBe('ksr-2026-10-11.db');
    expect(readdirSync(dir)).toHaveLength(14);
  });
});
