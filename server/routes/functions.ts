// The former Supabase edge functions, now /api/fn/<name> with the same request/response
// contracts (the web app calls them unchanged). Errors are { error, code, hint? }
// (see errorResponse in server/http.ts).
//
//   POST /submit-booking       public            booking request from the website (5.4, 9.2)
//   POST /document-upload      admin             multipart upload into the document centre (6.8)
//   POST /document-view-url    admin             5-minute signed link, logged (DOC-05/07)
//   POST /create-upload-link   admin             one-time customer upload link (DOC-16)
//   GET  /customer-upload      public            check an upload link
//   POST /customer-upload      public            customer self-upload, all files or none
//   POST /retention-purge      Owner (two-step)  erase documents past retention (10.4)
//   POST /admin-staff          Owner (two-step)  invite and manage staff accounts (SET-05)
import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { APP_ROLES, DOC_OWNER_TYPES, LOCALES, ROLE_LABELS, type AppRole, type DocOwnerType, type Locale } from '../../shared/constants.ts';
import { EXT_FOR_MIME, MAX_UPLOAD_BYTES, SELF_UPLOAD_DOC_TYPES, sniffMime, type StoredDocMime } from '../../shared/documents.ts';
import { fillTemplate } from '../../shared/settings.ts';
import { isIsoDate, istParts } from '../../shared/time.ts';
import { MESSAGES, normalizePhone, validateBookingRequest, validateEmail, type BookingField } from '../../shared/validation.ts';
import { anonCtx, systemCtx, type Ctx } from '../access/context.ts';
import { bookingVisibleSql, customerVisibleSql } from '../access/scope.ts';
import { writeAudit } from '../audit.ts';
import { randomToken, sha256Hex } from '../auth/crypto.ts';
import { revokeUserSessions } from '../auth/sessions.ts';
import { createAuthToken, passwordLink, type AuthTokenKind } from '../auth/tokens.ts';
import { config, smtpConfigured } from '../config.ts';
import { all, nowIso, one, run, tx } from '../db/connection.ts';
import { insertRow, updateRow } from '../db/write.ts';
import { ApiError } from '../errors.ts';
import { requireUser, type AppContext, type AppEnv } from '../http.ts';
import { computeDocumentRetention, purgeStaleRecords } from '../jobs/tasks.ts';
import { sendMail } from '../mailer.ts';
import { drainSoon } from '../notify.ts';
import { enqueueEmail, recipients } from '../outbox.ts';
import { ipHash, registerAttempt } from '../ratelimit.ts';
import { createBooking, type CreateBookingResult } from '../rpc/booking.ts';
import {
  canUploadDocument,
  documentAccess,
  documentDuplicates,
  eraseDocumentRow,
  logDocumentAccess,
  registerDocument,
  retentionDue,
} from '../rpc/documents.ts';
import { currentNoticeVersion, getSetting } from '../settings.ts';
import { fileExists, isValidStoragePath, removeFiles, saveFile } from '../storage.ts';
import { limitBody, requireRole, requireRoles, signDocumentLink } from './files.ts';

export const functionRoutes = new Hono<AppEnv>();

// ================================================================== plumbing

const GENERIC_ERROR = 'Something went wrong. Try again.';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const apiError = (status: number, message: string, code: string, hint?: unknown) => new ApiError(message, code, { status, hint });
const invalid = (field: string, message: string) => apiError(422, message, 'validation', { [field]: message });

function json(c: AppContext, body: Record<string, unknown>) {
  c.header('Cache-Control', 'no-store');
  return c.json(body);
}

/** Error name and message only: never request data. */
const describe = (err: unknown) => `${(err as Error)?.name ?? 'Error'}: ${(err as Error)?.message ?? String(err)}`;

/** A trimmed string, or '' for anything that is not a string. */
const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** A trimmed string, or null when empty / not a string. */
function optStr(value: unknown): string | null {
  const s = str(value);
  return s === '' ? null : s;
}

/** A UUID (lower-cased), or null when empty. 400 when present but malformed. */
function optUuid(value: unknown, field: string): string | null {
  const s = optStr(value);
  if (s === null) return null;
  if (!UUID_RE.test(s)) throw apiError(400, 'Invalid reference.', 'invalid', { [field]: 'Invalid id.' });
  return s.toLowerCase();
}

function requireUuid(value: unknown, field: string, notFoundMessage = 'Not found.'): string {
  const s = optUuid(value, field);
  if (s === null) throw apiError(404, notFoundMessage, 'not_found');
  return s;
}

/** Parse a JSON object body, or throw a 400. */
async function readJson(c: AppContext): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    const text = await c.req.text();
    body = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw apiError(400, 'Send the request as JSON.', 'bad_request');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw apiError(400, 'Send the request as a JSON object.', 'bad_request');
  return body as Record<string, unknown>;
}

/** Parse a multipart/form-data body, or throw a 400. */
async function readForm(c: AppContext): Promise<FormData> {
  const type = c.req.header('content-type') ?? '';
  if (!type.toLowerCase().startsWith('multipart/form-data')) throw apiError(400, 'Send the files as a form upload.', 'bad_request');
  try {
    return await c.req.formData();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw apiError(400, "Couldn't read the upload. Try again.", 'bad_request');
  }
}

const userAgent = (ctx: Ctx) => ctx.ua?.slice(0, 400) ?? null;

// ================================================================== uploaded files (6.8.2, 6.8.3, 10.5)

const FILE_MESSAGES = {
  missing: 'Choose a file to upload.',
  empty: 'This file is empty. Choose another file.',
  tooLarge: 'This file is larger than 10 MB. Choose a smaller file or a lower-resolution photo.',
  heic: "This photo is in HEIC format and couldn't be converted. Try again, or save it as JPG first and upload that.",
  type: 'Upload a JPG, PNG, WebP or PDF file.',
} as const;

interface CheckedFile {
  bytes: Uint8Array;
  mime: StoredDocMime;
  ext: string;
  size: number;
  /** Lower-case hex SHA-256 computed on the server. */
  sha256: string;
  /** Original name, cleaned, with an extension that matches the real type. */
  filename: string;
}

/** The File in a multipart field, or null when the field is absent or not a file. */
function formFile(form: FormData, field: string): File | null {
  const v = form.get(field);
  return v !== null && typeof v !== 'string' ? v : null;
}

function fileError(status: number, message: string, code: string, field?: string): ApiError {
  return apiError(status, message, code, field ? { [field]: message } : undefined);
}

/** Base name without folders or control characters, with an extension matching the real type. */
function safeFilename(name: string | undefined, ext: string, fallbackBase = 'document'): string {
  const raw = (name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = [...raw]
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    })
    .join('')
    .trim();
  const dot = cleaned.lastIndexOf('.');
  const stem = (dot > 0 ? cleaned.slice(0, dot) : cleaned).trim() || fallbackBase;
  const current = dot > 0 ? cleaned.slice(dot + 1).toLowerCase() : '';
  const accepted = ext === 'jpg' ? ['jpg', 'jpeg'] : [ext];
  const finalExt = accepted.includes(current) ? current : ext;
  return `${[...stem].slice(0, 200).join('')}.${finalExt}`;
}

/** Enforce the size limit and allowed types (by content, not name), and fingerprint the file. */
async function checkFile(file: File, field?: string, fallbackName = 'document'): Promise<CheckedFile> {
  if (file.size === 0) throw fileError(400, FILE_MESSAGES.empty, 'empty_file', field);
  if (file.size > MAX_UPLOAD_BYTES) throw fileError(413, FILE_MESSAGES.tooLarge, 'file_too_large', field);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length === 0) throw fileError(400, FILE_MESSAGES.empty, 'empty_file', field);
  if (bytes.length > MAX_UPLOAD_BYTES) throw fileError(413, FILE_MESSAGES.tooLarge, 'file_too_large', field);

  const sniffed = sniffMime(bytes.subarray(0, 64));
  // HEIC is converted to JPG in the browser before upload; one arriving here means that failed.
  if (sniffed === 'image/heic') throw fileError(415, FILE_MESSAGES.heic, 'heic', field);
  if (!sniffed) throw fileError(415, FILE_MESSAGES.type, 'unsupported_type', field);

  const ext = EXT_FOR_MIME[sniffed];
  return {
    bytes,
    mime: sniffed,
    ext,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    filename: safeFilename(file.name, ext, fallbackName),
  };
}

/**
 * Storage path (6.8.3). File names are random ids; the original name lives only in the database.
 *   customers/{customer_id}/{doc_type}/{id}.{ext}     bookings/{booking_id}/{doc_type}/{id}.{ext}
 *   vehicles/{car_id}/{doc_type}/{id}.{ext}           business/{doc_type}/{id}.{ext}
 */
export function documentStoragePath(ownerType: DocOwnerType, ownerId: string | null, docType: string, fileId: string, ext: string): string {
  if (ownerType === 'business') return `business/${docType}/${fileId}.${ext}`;
  if (!ownerId) throw new Error('ownerId is required for non-business documents');
  const folder = ownerType === 'customer' ? 'customers' : ownerType === 'booking' ? 'bookings' : 'vehicles';
  return `${folder}/${ownerId}/${docType}/${fileId}.${ext}`;
}

/** Save to the private documents store (never overwrites). */
async function storeDocumentFile(path: string, bytes: Uint8Array): Promise<void> {
  try {
    await saveFile('documents', path, bytes);
  } catch (err) {
    console.error('[storage] save failed', describe(err));
    throw apiError(500, "Couldn't save the file. Try again.", 'storage');
  }
}

/** Best-effort removal (undoing an upload whose database record failed). */
async function discardDocumentFiles(paths: string[]): Promise<void> {
  if (!paths.length) return;
  try {
    await removeFiles('documents', paths);
  } catch (err) {
    console.error('[storage] remove failed', describe(err));
  }
}

// ================================================================== submit-booking (public)
// POST JSON { car_id, package: '12h'|'24h', pickup_date, pickup_time, full_name, phone, dl_number,
//             email?, consent: true, website?: '' (honeypot), locale? }
// 200 { ok: true, booking_code, pickup_at, return_due_at, price_paise, phone }
// 200 { ok: false, error: 'clash', message, suggestions }
// 200 { ok: true, booking_code: null }      honeypot filled (nothing saved)
// 422 validation (hint: { field: message })  429 rate_limited

const BOOKING_FIELDS: readonly string[] = ['car_id', 'package', 'pickup', 'full_name', 'phone', 'dl_number', 'email', 'consent'] satisfies BookingField[];

const validationError = (errors: Partial<Record<string, string>>) => apiError(422, 'Check the highlighted fields.', 'validation', errors);

const toIso = (value: string | undefined) => (value ? new Date(value).toISOString() : null);

const parseLocale = (value: unknown): Locale => ((LOCALES as readonly string[]).includes(str(value)) ? (str(value) as Locale) : 'en');

functionRoutes.post('/submit-booking', async (c) => {
  const body = await readJson(c);

  // Honeypot: bots fill the hidden field. Pretend it worked and save nothing.
  if (str(body.website) !== '') return json(c, { ok: true, booking_code: null });

  // BK-06: every rule is checked again here.
  const check = validateBookingRequest(
    {
      car_id: str(body.car_id),
      package: str(body.package),
      pickup_date: str(body.pickup_date),
      pickup_time: str(body.pickup_time),
      full_name: typeof body.full_name === 'string' ? body.full_name : '',
      phone: str(body.phone),
      dl_number: str(body.dl_number),
      email: optStr(body.email),
      consent: body.consent === true,
    },
    { rules: getSetting('booking_rules'), hours: getSetting('business').hours },
  );
  if (!check.ok) throw validationError(check.errors);
  const value = check.value;
  const locale = parseLocale(body.locale);
  const { ip } = c.var.ctx;
  const ua = userAgent(c.var.ctx);

  // BK-11: at most 5 per mobile number and 20 per IP address per hour.
  const allowed = tx(() => registerAttempt('booking', value.phone, ipHash(ip, config.rateLimitSalt), 5, 20));
  if (!allowed) throw apiError(429, MESSAGES.tooManyRequests, 'rate_limited');

  const noticeVersion = currentNoticeVersion(locale);
  let result: CreateBookingResult;
  try {
    // Website requests are anonymous even if an admin happens to be signed in in this browser.
    result = tx(() =>
      createBooking(anonCtx(ip, ua), {
        carId: value.car_id,
        package: value.package,
        pickupAt: value.pickup_at.toISOString(),
        customHours: null,
        fullName: value.full_name,
        phone: value.phone,
        dlNumber: value.dl_number,
        email: value.email,
        source: 'website',
        createdBy: null,
        noticeVersion,
        consentChannel: 'website',
        ip,
        userAgent: ua,
        rejectOnClash: true,
        staff: false,
      }),
    );
  } catch (err) {
    // Field rules repeated in the booking logic come back with the field name as the code.
    if (err instanceof ApiError && err.detail && BOOKING_FIELDS.includes(err.detail)) throw validationError({ [err.detail]: err.message });
    throw err;
  }

  if (!result.ok) {
    const r = result as { error?: string; message?: string; suggestions?: unknown[] };
    if (r.error === 'clash') return json(c, { ok: false, error: 'clash', message: r.message ?? MESSAGES.carClash, suggestions: r.suggestions ?? [] });
    throw apiError(400, r.message ?? GENERIC_ERROR, r.error ?? 'invalid');
  }

  // The new-request email was queued with the booking; send it without delaying the customer.
  drainSoon();
  return json(c, {
    ok: true,
    booking_code: result.booking_code,
    pickup_at: toIso(result.pickup_at),
    return_due_at: toIso(result.return_due_at),
    price_paise: result.price_paise,
    phone: value.phone,
  });
});

// ================================================================== document-upload (admin)
// POST multipart: file, owner_type, owner_id (omit for business), doc_type, sha256 (client hex),
//   doc_number?, issue_date?, expiry_date?, notes?, replaces_id?, aadhaar_masked_confirmed ('true'),
//   context_booking_id?
// 200 { document, duplicates: [{ id, doc_type, owner_type, owner_id, created_at }] }
// 403 "You can't upload this document here."   409 duplicate   400/413/415 file problems

const DOC_TYPE_RE = /^[a-z][a-z0-9_]{1,40}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
/** One file of up to 10 MB plus form fields and multipart overhead. */
const MAX_DOCUMENT_BODY = 11 * 1024 * 1024;

function optDate(value: unknown, field: string): string | null {
  const s = optStr(value);
  if (s === null) return null;
  if (!isIsoDate(s)) throw invalid(field, 'Enter a valid date.');
  return s;
}

/** A live document with the same fingerprint for the same owner and type (DOC-04). */
function findDuplicate(ownerType: DocOwnerType, ownerId: string | null, docType: string, sha256: string): string | null {
  const row = ownerId
    ? one<{ id: string }>(
        `SELECT id FROM documents WHERE sha256 = ? AND doc_type = ? AND owner_type = ? AND owner_id = ? AND deleted_at IS NULL LIMIT 1`,
        sha256,
        docType,
        ownerType,
        ownerId,
      )
    : one<{ id: string }>(
        `SELECT id FROM documents WHERE sha256 = ? AND doc_type = ? AND owner_type = ? AND deleted_at IS NULL LIMIT 1`,
        sha256,
        docType,
        ownerType,
      );
  return row?.id ?? null;
}

const duplicateError = (documentId: string) => apiError(409, 'This file is already uploaded here.', 'duplicate', { document_id: documentId });

functionRoutes.post('/document-upload', requireRoles(), limitBody(MAX_DOCUMENT_BODY), async (c) => {
  const ctx = requireUser(c);
  const form = await readForm(c);

  // ------------------------------------------------------------ fields
  const ownerTypeRaw = str(form.get('owner_type'));
  if (!(DOC_OWNER_TYPES as readonly string[]).includes(ownerTypeRaw)) throw invalid('owner_type', 'Choose what this document belongs to.');
  const ownerType = ownerTypeRaw as DocOwnerType;
  const ownerId = ownerType === 'business' ? null : optUuid(form.get('owner_id'), 'owner_id');
  if (ownerType !== 'business' && !ownerId) throw invalid('owner_id', 'Choose what this document belongs to.');

  const docType = str(form.get('doc_type'));
  if (!DOC_TYPE_RE.test(docType)) throw invalid('doc_type', 'Choose a document type.');

  const clientSha = str(form.get('sha256')).toLowerCase();
  if (!SHA_RE.test(clientSha)) throw apiError(400, 'The file fingerprint is missing. Try again.', 'checksum_missing');

  const docNumber = optStr(form.get('doc_number'));
  if (docNumber && docNumber.replace(/\s/g, '').length > 40) throw invalid('doc_number', 'The document number is too long.');
  const issueDate = optDate(form.get('issue_date'), 'issue_date');
  const expiryDate = optDate(form.get('expiry_date'), 'expiry_date');
  const notes = (optStr(form.get('notes')) ?? '').slice(0, 2000);
  const replacesId = optUuid(form.get('replaces_id'), 'replaces_id');
  const aadhaarMaskedConfirmed = str(form.get('aadhaar_masked_confirmed')) === 'true';
  // Only customer documents carry the booking they were uploaded in.
  const contextBookingId = ownerType === 'customer' ? optUuid(form.get('context_booking_id'), 'context_booking_id') : null;

  // ------------------------------------------------------------ permission (caller's role and scope)
  if (!canUploadDocument(ctx, ownerType, ownerId, docType)) throw apiError(403, "You can't upload this document here.", 'forbidden');

  if (contextBookingId) {
    const booking = one<{ customer_id: string }>('SELECT customer_id FROM bookings WHERE id = ?', contextBookingId);
    if (!booking || booking.customer_id !== ownerId) throw invalid('context_booking_id', "This booking isn't for this customer.");
  }

  // ------------------------------------------------------------ file
  const upload = formFile(form, 'file');
  if (!upload) throw apiError(400, FILE_MESSAGES.missing, 'file_missing');
  const file = await checkFile(upload, undefined, docType);
  if (file.sha256 !== clientSha) throw apiError(400, 'The file changed during upload. Try again.', 'checksum_mismatch');

  const existing = findDuplicate(ownerType, ownerId, docType, file.sha256);
  if (existing) throw duplicateError(existing);

  // ------------------------------------------------------------ store, then register
  const path = documentStoragePath(ownerType, ownerId, docType, randomUUID(), file.ext);
  await storeDocumentFile(path, file.bytes);

  let document: ReturnType<typeof registerDocument>;
  try {
    document = tx(() => {
      // Checked again inside the transaction, in case the same file arrived twice at once.
      const again = findDuplicate(ownerType, ownerId, docType, file.sha256);
      if (again) throw duplicateError(again);
      return registerDocument(ctx, {
        actorId: ctx.userId,
        ownerType,
        ownerId,
        docType,
        storagePath: path,
        originalFilename: file.filename,
        mime: file.mime,
        size: file.size,
        sha256: file.sha256,
        docNumber,
        issueDate,
        expiryDate,
        notes,
        replacesId,
        aadhaarMaskedConfirmed,
        uploadedVia: 'admin',
        uploadLinkId: null,
        contextBookingId,
      });
    });
  } catch (err) {
    await discardDocumentFiles([path]);
    throw err;
  }

  // Same fingerprint elsewhere, limited to what this user may see.
  let duplicates: ReturnType<typeof documentDuplicates> = [];
  try {
    duplicates = documentDuplicates(ctx, file.sha256).filter((d) => d.id !== document.id);
  } catch (err) {
    console.error('[document-upload] duplicate lookup failed', describe(err));
  }
  return json(c, { document, duplicates });
});

// ================================================================== document-view-url (admin)
// POST JSON { document_id, download?: boolean }
// 200 { url, expires_at, filename, mime_type, watermark: string | null }
// 404 'Document not found.'   403 "You can't download this document. You can view it in the app."

const NOT_FOUND_DOCUMENT = 'Document not found.';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "DD Mon YYYY" in IST, e.g. "05 Oct 2026". */
function istDateLabel(d: Date): string {
  const p = istParts(d);
  return `${String(p.day).padStart(2, '0')} ${MONTHS[p.month - 1]} ${p.year}`;
}

functionRoutes.post('/document-view-url', requireRoles(), async (c) => {
  const ctx = requireUser(c);
  const body = await readJson(c);
  const documentId = requireUuid(body.document_id, 'document_id', NOT_FOUND_DOCUMENT);
  const download = body.download === true;

  // Role and staff-scope check as the caller.
  const access = documentAccess(ctx, documentId);
  if (!access?.can_view || !access.storage_path) throw apiError(404, NOT_FOUND_DOCUMENT, 'not_found');
  if (download && !access.can_download) throw apiError(403, "You can't download this document. You can view it in the app.", 'forbidden');

  if (!isValidStoragePath(access.storage_path) || !(await fileExists('documents', access.storage_path))) {
    throw apiError(404, 'The file for this document is missing.', 'file_missing');
  }

  // Log before handing out the link; if logging fails, no link (DOC-07).
  tx(() => logDocumentAccess(ctx, documentId, download ? 'document.download' : 'document.view'));

  const now = new Date();
  const link = signDocumentLink(documentId, download, now.getTime());
  return json(c, {
    url: link.url,
    expires_at: link.expiresAt,
    filename: access.original_filename ?? 'document',
    mime_type: access.mime_type ?? 'application/octet-stream',
    watermark: access.is_kyc ? `KSR Self Drive Cars — for rental verification only — ${istDateLabel(now)}` : null,
  });
});

// ================================================================== create-upload-link (admin)
// POST JSON { customer_id, booking_id? }
// 200 { url: `${SITE_URL}/upload/${token}`, expires_at, message }
// The token is shown once; only its SHA-256 is stored. Links are one-time and last 24 hours.

const LINK_HOURS = 24;

const firstName = (fullName: string | null | undefined) => (fullName ?? '').trim().split(/\s+/)[0] ?? '';

functionRoutes.post('/create-upload-link', requireRoles(), async (c) => {
  const ctx = requireUser(c);
  const body = await readJson(c);
  const customerId = requireUuid(body.customer_id, 'customer_id', 'Customer not found.');
  const bookingId = optUuid(body.booking_id, 'booking_id');

  // Scope as the caller: Staff only reach today's customers.
  const customerScope = customerVisibleSql(ctx, 'c');
  const customer = one<{ id: string; full_name: string; erased_at: string | null }>(
    `SELECT c.id, c.full_name, c.erased_at FROM customers c WHERE c.id = ? AND (${customerScope.sql})`,
    customerId,
    ...customerScope.params,
  );
  if (!customer || customer.erased_at) throw apiError(404, 'Customer not found.', 'not_found');

  if (bookingId) {
    const bookingScope = bookingVisibleSql(ctx, 'b');
    const booking = one<{ customer_id: string }>(
      `SELECT b.customer_id FROM bookings b WHERE b.id = ? AND (${bookingScope.sql})`,
      bookingId,
      ...bookingScope.params,
    );
    if (!booking || booking.customer_id !== customerId) throw apiError(404, 'Booking not found.', 'not_found');
  }

  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + LINK_HOURS * 3_600_000).toISOString();
  tx(() => {
    const link = insertRow<{ id: string }>(ctx, 'upload_links', {
      customer_id: customerId,
      booking_id: bookingId,
      token_hash: sha256Hex(token),
      expires_at: expiresAt,
      created_by: ctx.userId,
    });
    writeAudit(ctx, 'upload_link.create', 'customers', customerId, null, { upload_link_id: link.id, booking_id: bookingId, expires_at: expiresAt });
  });

  const url = `${config.siteUrl}/upload/${token}`;
  const message = fillTemplate(getSetting('templates').upload_link, { name: firstName(customer.full_name), link: url });
  return json(c, { url, expires_at: expiresAt, message });
});

// ================================================================== customer-upload (public)
// GET  ?token=…  200 { valid: true, first_name, expires_at, business_name, doc_types: [{ key, label }] }
// POST multipart: token, consent ('true'), aadhaar_masked_confirmed ('true' with file_aadhaar_masked),
//      locale?, file_dl_front?, file_dl_back?, file_aadhaar_masked?, file_other_photo_id? (at least one)
//      200 { ok: true, uploaded: <count> }
// 410 { error: 'This link has expired or was already used. Ask us for a new one.', code: 'link_invalid' }
// All files are saved, or none are: on any failure the saved files and records are rolled back
// and the link stays usable.

type SelfUploadType = (typeof SELF_UPLOAD_DOC_TYPES)[number];

const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
/** Four files of up to 10 MB each plus form fields and multipart overhead. */
const MAX_CUSTOMER_UPLOAD_BODY = 41 * 1024 * 1024;

const linkInvalid = () => apiError(410, 'This link has expired or was already used. Ask us for a new one.', 'link_invalid');

interface UploadLink {
  id: string;
  customer_id: string;
  booking_id: string | null;
  expires_at: string;
  used_at: string | null;
  full_name: string | null;
  erased_at: string | null;
}

function findValidLink(token: string): UploadLink {
  if (!TOKEN_RE.test(token)) throw linkInvalid();
  const link = one<UploadLink>(
    `SELECT l.id, l.customer_id, l.booking_id, l.expires_at, l.used_at, c.full_name, c.erased_at
       FROM upload_links l LEFT JOIN customers c ON c.id = l.customer_id
      WHERE l.token_hash = ?`,
    sha256Hex(token),
  );
  if (!link || link.used_at || link.expires_at <= nowIso() || link.full_name === null || link.erased_at) throw linkInvalid();
  return link;
}

/** Labels for the self-upload types, in display order. */
function docTypeLabels(): Array<{ key: SelfUploadType; label: string }> {
  const rows = all<{ key: string; label: string }>(
    `SELECT key, label FROM document_types WHERE active = 1 AND key IN (${SELF_UPLOAD_DOC_TYPES.map(() => '?').join(', ')})`,
    ...SELF_UPLOAD_DOC_TYPES,
  );
  const labels = new Map(rows.map((r) => [r.key, r.label]));
  return SELF_UPLOAD_DOC_TYPES.filter((k) => labels.has(k)).map((key) => ({ key, label: labels.get(key)! }));
}

functionRoutes.get('/customer-upload', (c) => {
  const link = findValidLink(c.req.query('token') ?? '');
  return json(c, {
    valid: true,
    first_name: firstName(link.full_name),
    expires_at: new Date(link.expires_at).toISOString(),
    business_name: getSetting('business').name,
    doc_types: docTypeLabels(),
  });
});

functionRoutes.post('/customer-upload', limitBody(MAX_CUSTOMER_UPLOAD_BODY, 'The upload is too large. Each file can be up to 10 MB.'), async (c) => {
  const { ip } = c.var.ctx;
  const ua = userAgent(c.var.ctx);
  // The customer acts anonymously, even if an admin is signed in in this browser.
  const actor = anonCtx(ip, ua);

  const allowed = tx(() => registerAttempt('upload', null, ipHash(ip, config.rateLimitSalt), 0, 20));
  if (!allowed) throw apiError(429, MESSAGES.tooManyRequests, 'rate_limited');

  const form = await readForm(c);
  const link = findValidLink(str(form.get('token')));

  if (str(form.get('consent')) !== 'true') {
    const message = 'Tick the box to agree to how we use your documents.';
    throw apiError(422, message, 'consent', { consent: message });
  }

  const allTypes = docTypeLabels();
  const labelOf = (key: string) => allTypes.find((t) => t.key === key)?.label ?? key;
  const chosen: Array<{ docType: SelfUploadType; field: string; upload: File }> = [];
  for (const { key } of allTypes) {
    const field = `file_${key}`;
    const upload = formFile(form, field);
    if (upload) chosen.push({ docType: key, field, upload });
  }
  if (chosen.length === 0) throw apiError(422, 'Add at least one photo or PDF.', 'no_files');
  const aadhaarConfirmed = str(form.get('aadhaar_masked_confirmed')) === 'true';
  if (chosen.some((ch) => ch.docType === 'aadhaar_masked') && !aadhaarConfirmed) {
    const message = 'Confirm that only the last 4 digits of the Aadhaar number are visible.';
    throw apiError(422, message, 'aadhaar_mask', { aadhaar_masked_confirmed: message });
  }

  // Check every file before saving any.
  const files: Array<{ docType: SelfUploadType; file: CheckedFile }> = [];
  for (const ch of chosen) {
    try {
      files.push({ docType: ch.docType, file: await checkFile(ch.upload, ch.field, ch.docType) });
    } catch (err) {
      if (err instanceof ApiError) throw new ApiError(`${labelOf(ch.docType)}: ${err.message}`, err.detail, { status: err.status, hint: err.hint });
      throw err;
    }
  }

  // Claim the link so two submissions can't both use it.
  const claimed = tx(() => {
    const now = nowIso();
    return run(`UPDATE upload_links SET used_at = ?, updated_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?`, now, now, link.id, now).changes;
  });
  if (claimed === 0) throw linkInvalid();

  const storedPaths: string[] = [];
  const registeredIds: string[] = [];
  try {
    const planned = files.map(({ docType, file }) => ({
      docType,
      file,
      path: documentStoragePath('customer', link.customer_id, docType, randomUUID(), file.ext),
    }));
    for (const p of planned) {
      await storeDocumentFile(p.path, p.file.bytes);
      storedPaths.push(p.path);
    }

    // Consent and every document in one transaction: all of them are recorded, or none.
    const noticeVersion = currentNoticeVersion(parseLocale(form.get('locale')));
    tx(() => {
      insertRow(actor, 'consents', {
        customer_id: link.customer_id,
        booking_id: link.booking_id,
        purpose: 'document_upload',
        notice_version: noticeVersion,
        channel: 'customer_link',
        ip,
        user_agent: ua,
      });
      for (const p of planned) {
        const doc = registerDocument(actor, {
          actorId: null,
          ownerType: 'customer',
          ownerId: link.customer_id,
          docType: p.docType,
          storagePath: p.path,
          originalFilename: p.file.filename,
          mime: p.file.mime,
          size: p.file.size,
          sha256: p.file.sha256,
          docNumber: null,
          issueDate: null,
          expiryDate: null,
          notes: '',
          replacesId: null,
          aadhaarMaskedConfirmed: p.docType === 'aadhaar_masked' && aadhaarConfirmed,
          uploadedVia: 'customer_link',
          uploadLinkId: link.id,
          contextBookingId: link.booking_id,
        });
        if (doc && typeof doc.id === 'string') registeredIds.push(doc.id);
      }
    });
  } catch (err) {
    // Roll back: files first, then any records that were kept (each erasure is audited),
    // then free the link so the customer can try again.
    await discardDocumentFiles(storedPaths);
    for (const id of registeredIds) {
      try {
        if (one('SELECT 1 FROM documents WHERE id = ?', id)) tx(() => eraseDocumentRow(systemCtx(), id, 'Customer upload failed and was rolled back'));
      } catch (eraseErr) {
        console.error('[customer-upload] rollback failed', describe(eraseErr));
      }
    }
    try {
      tx(() => run('UPDATE upload_links SET used_at = NULL, updated_at = ? WHERE id = ?', nowIso(), link.id));
    } catch (releaseErr) {
      console.error('[customer-upload] could not release the link', describe(releaseErr));
    }
    throw err;
  }

  // Tell the Owner/Manager (Section 11). No personal data beyond the first name.
  try {
    const name = firstName(link.full_name) || 'A customer';
    tx(() =>
      enqueueEmail(
        'customer_upload',
        recipients('upload_emails'),
        'Customer uploaded documents',
        [
          `${name} uploaded ${files.length} document${files.length === 1 ? '' : 's'} through an upload link:`,
          ...files.map((f) => `- ${labelOf(f.docType)}`),
          '',
          'They are Pending. Check and verify them before pickup.',
        ].join('\n'),
        { path: `/admin/customers/${link.customer_id}` },
        `customer_upload:${link.id}`,
      ),
    );
    drainSoon();
  } catch (err) {
    console.error('[customer-upload] could not queue the notification', describe(err));
  }

  return json(c, { ok: true, uploaded: files.length });
});

// ================================================================== retention-purge (Owner, two-step)
// POST (no body). The daily job calls runRetentionPurge() directly (server/jobs/scheduler.ts).
// Erases files of soft-deleted and past-retention documents (skipping holds), then their
// records (each erasure is audited), then stale requests, orphan customers and old logs.
// 200 { erased, failed, batches, stale }

const PURGE_BATCH_SIZE = 200;
const PURGE_MAX_BATCHES = 20;

export interface RetentionPurgeResult {
  erased: number;
  failed: number;
  batches: number;
  stale: Record<string, number>;
}

export async function runRetentionPurge(ctx: Ctx): Promise<RetentionPurgeResult> {
  // Bring retention dates up to date first.
  tx(() => computeDocumentRetention(ctx));

  let erased = 0;
  let failed = 0;
  let batches = 0;
  const attempted = new Set<string>();

  while (batches < PURGE_MAX_BATCHES) {
    // Rows that failed earlier in this run come back first; don't loop on them.
    const due = retentionDue(PURGE_BATCH_SIZE).filter((d) => !attempted.has(d.id));
    if (due.length === 0) break;
    batches++;
    for (const d of due) attempted.add(d.id);

    // Files first (missing files count as gone), then the records.
    const removable = due.filter((d) => isValidStoragePath(d.storage_path));
    try {
      await removeFiles('documents', removable.map((d) => d.storage_path));
    } catch (err) {
      console.error('[retention-purge] removing files failed', describe(err));
      failed += due.length;
      break;
    }
    for (const d of due) {
      if (!isValidStoragePath(d.storage_path)) {
        failed++;
        console.error('[retention-purge] skipped a document with an invalid storage path');
        continue;
      }
      try {
        tx(() => eraseDocumentRow(ctx, d.id, d.reason));
        erased++;
      } catch (err) {
        failed++;
        console.error('[retention-purge] erase failed', describe(err));
      }
    }
  }

  const stale = tx(() => purgeStaleRecords(ctx));
  return { erased, failed, batches, stale };
}

functionRoutes.post('/retention-purge', requireRoles(['owner']), async (c) => {
  const ctx = requireUser(c);
  if (ctx.aal !== 'aal2') throw apiError(403, 'Complete two-step verification to continue.', 'mfa_required');
  // Erasures run as the system (like the daily job); the run itself is recorded with the Owner as actor.
  const result = await runRetentionPurge({ ...systemCtx(), ip: ctx.ip, ua: ctx.ua });
  try {
    tx(() => writeAudit(ctx, 'retention.purge', 'documents', null, null, { ...result }));
  } catch (err) {
    console.error('[retention-purge] audit failed', describe(err));
  }
  return json(c, { ...result });
});

// ================================================================== admin-staff (Owner, two-step)
// POST JSON { action, ... }:
//   invite         { email, full_name, role, phone? }
//   set_role       { user_id, role }
//   deactivate     { user_id }            ends their sessions and blocks data access at once
//   reactivate     { user_id }
//   resend_invite  { user_id }            invite again, or a password-reset email if already joined
//   update_profile { user_id, full_name?, phone? }
// 200 { ok: true, user_id }  (+ link: the set-password link, only when email isn't configured)

interface StaffRow {
  user_id: string;
  full_name: string;
  email: string;
  phone: string | null;
  active: boolean;
  role: AppRole | null;
}

interface StaffCall {
  ctx: Ctx;
  body: Record<string, unknown>;
}

interface StaffResult {
  user_id: string;
  /** Set-password link, returned only when SMTP isn't configured so the Owner can pass it on. */
  link?: string;
}

const staffNotFound = () => apiError(404, 'Staff member not found.', 'not_found');

function parseRole(value: unknown): AppRole {
  const role = str(value);
  if (!(APP_ROLES as readonly string[]).includes(role)) throw invalid('role', 'Choose Owner, Manager or Staff.');
  return role as AppRole;
}

function parseName(value: unknown): string {
  const name = str(value).replace(/\s+/g, ' ');
  if (name.length < 1 || [...name].length > 80) throw invalid('full_name', 'Enter a name of up to 80 characters.');
  return name;
}

function parseEmail(value: unknown): string {
  const email = str(value).toLowerCase();
  if (!email) throw invalid('email', 'Enter an email address.');
  const problem = validateEmail(email);
  if (problem) throw invalid('email', problem);
  return email;
}

/** Optional mobile: '' clears it, anything else must be a valid Indian mobile. */
function parsePhone(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  const phone = normalizePhone(raw);
  if (!phone) throw invalid('phone', MESSAGES.phoneInvalid);
  return phone;
}

function loadStaff(userId: string): StaffRow {
  const row = one<Omit<StaffRow, 'active'> & { active: number }>(
    `SELECT p.user_id, p.full_name, p.email, p.phone, p.active, r.role
       FROM staff_profiles p LEFT JOIN user_roles r ON r.user_id = p.user_id
      WHERE p.user_id = ?`,
    userId,
  );
  if (!row) throw staffNotFound();
  return { ...row, active: row.active === 1 };
}

/** Active Owners other than `userId`. */
const otherActiveOwners = (userId: string) =>
  one<{ n: number }>(
    `SELECT count(*) AS n FROM user_roles r
       JOIN staff_profiles p ON p.user_id = r.user_id
       JOIN users u ON u.id = r.user_id
      WHERE r.role = 'owner' AND p.active = 1 AND u.banned = 0 AND r.user_id <> ?`,
    userId,
  )!.n;

function ensureNotLastOwner(staff: StaffRow): void {
  if (staff.role === 'owner' && staff.active && otherActiveOwners(staff.user_id) === 0) {
    throw apiError(409, 'There must always be at least one active Owner.', 'last_owner');
  }
}

/** Explicit audit entry with the Owner as actor. */
const audit = (s: StaffCall, action: string, userId: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null) =>
  writeAudit(s.ctx, action, 'staff_profiles', userId, before, after);

function passwordEmail(kind: AuthTokenKind, fullName: string, role: AppRole | null, link: string): { subject: string; text: string } {
  const business = getSetting('business').name || 'KSR Self Drive Cars';
  const hi = `Hi ${firstName(fullName) || 'there'},`;
  if (kind === 'invite') {
    return {
      subject: `You're invited to the ${business} admin`,
      text: `${hi}\n\nYou've been invited to the ${business} admin${role ? ` as ${ROLE_LABELS[role]}` : ''}. Choose your password here (the link works once and expires in 7 days):\n${link}\n\nIf you weren't expecting this, ignore this email.`,
    };
  }
  return {
    subject: `Reset your ${business} admin password`,
    text: `${hi}\n\nChoose a new password for the ${business} admin here (the link works once and expires in 1 hour):\n${link}\n\nIf you didn't ask for this, ignore this email.`,
  };
}

/** Email a set-password link. True when sent (or logged because SMTP isn't configured). */
async function emailPasswordLink(email: string, kind: AuthTokenKind, fullName: string, role: AppRole | null, link: string): Promise<boolean> {
  const message = passwordEmail(kind, fullName, role, link);
  const result = await sendMail([email], message.subject, message.text);
  if (result.sent || !smtpConfigured()) return true;
  console.error(`[admin-staff] could not send the ${kind} email`);
  return false;
}

async function invite(s: StaffCall): Promise<StaffResult> {
  const email = parseEmail(s.body.email);
  const fullName = parseName(s.body.full_name);
  const role = parseRole(s.body.role);
  const phone = parsePhone(s.body.phone);

  const { userId, token } = tx(() => {
    if (one('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE', email) || one('SELECT 1 FROM staff_profiles WHERE email = ? COLLATE NOCASE', email)) {
      throw apiError(409, 'This email already has an account.', 'exists');
    }
    // No password until they accept the invite (ADM-02: no public sign-up).
    const user = insertRow<{ id: string }>(s.ctx, 'users', { email }, { audit: false });
    insertRow(s.ctx, 'staff_profiles', { user_id: user.id, full_name: fullName, email, phone }, { audit: false });
    insertRow(s.ctx, 'user_roles', { user_id: user.id, role }, { audit: false });
    audit(s, 'staff.invite', user.id, null, { email, full_name: fullName, role, phone });
    return { userId: user.id, token: createAuthToken(user.id, 'invite') };
  });

  const link = passwordLink(token, 'invite');
  if (!(await emailPasswordLink(email, 'invite', fullName, role, link))) {
    // Undo the invite so the Owner can simply try again.
    tx(() => {
      run('DELETE FROM users WHERE id = ?', userId);
      audit(s, 'staff.invite_undone', userId, null, { reason: 'email_failed' });
    });
    throw apiError(502, "Couldn't send the invite. Try again.", 'auth_failed');
  }
  return { user_id: userId, link: smtpConfigured() ? undefined : link };
}

async function setRole(s: StaffCall): Promise<StaffResult> {
  const userId = requireUuid(s.body.user_id, 'user_id', 'Staff member not found.');
  const role = parseRole(s.body.role);
  if (userId === s.ctx.userId) throw apiError(400, "You can't change your own role.", 'self');
  tx(() => {
    const staff = loadStaff(userId);
    if (staff.role === role) return;
    if (role !== 'owner') ensureNotLastOwner(staff);
    const existing = one<{ id: string }>('SELECT id FROM user_roles WHERE user_id = ?', userId);
    if (existing) updateRow(s.ctx, 'user_roles', existing.id, { role }, { audit: false });
    else insertRow(s.ctx, 'user_roles', { user_id: userId, role }, { audit: false });
    audit(s, 'staff.role_change', userId, { role: staff.role }, { role });
  });
  return { user_id: userId };
}

async function deactivate(s: StaffCall): Promise<StaffResult> {
  const userId = requireUuid(s.body.user_id, 'user_id', 'Staff member not found.');
  if (userId === s.ctx.userId) throw apiError(400, "You can't deactivate your own account.", 'self');
  tx(() => {
    const staff = loadStaff(userId);
    ensureNotLastOwner(staff);
    // Data access stops as soon as the profile is inactive; ending the sessions signs them out.
    if (staff.active) {
      updateRow(s.ctx, 'staff_profiles', userId, { active: false }, { audit: false });
      audit(s, 'staff.deactivate', userId, { active: true }, { active: false });
    }
    revokeUserSessions(userId);
    // Unused invite and reset links stop working too.
    const now = nowIso();
    run('UPDATE auth_tokens SET used_at = ?, updated_at = ? WHERE user_id = ? AND used_at IS NULL', now, now, userId);
  });
  return { user_id: userId };
}

async function reactivate(s: StaffCall): Promise<StaffResult> {
  const userId = requireUuid(s.body.user_id, 'user_id', 'Staff member not found.');
  tx(() => {
    const staff = loadStaff(userId);
    if (!staff.active) {
      updateRow(s.ctx, 'staff_profiles', userId, { active: true }, { audit: false });
      audit(s, 'staff.reactivate', userId, { active: false }, { active: true });
    }
  });
  return { user_id: userId };
}

async function resendInvite(s: StaffCall): Promise<StaffResult> {
  const userId = requireUuid(s.body.user_id, 'user_id', 'Staff member not found.');
  const { staff, email, kind, token } = tx(() => {
    const staff = loadStaff(userId);
    if (!staff.active) throw apiError(409, 'Reactivate this account first.', 'inactive');
    const user = one<{ email: string; password_hash: string | null }>('SELECT email, password_hash FROM users WHERE id = ?', userId);
    if (!user) throw staffNotFound();
    // Not joined yet: a new invite. Already has a password: a password-reset link.
    const kind: AuthTokenKind = user.password_hash ? 'reset' : 'invite';
    const token = createAuthToken(userId, kind);
    audit(s, 'staff.resend_invite', userId, null, { method: kind === 'invite' ? 'invite' : 'recovery' });
    return { staff, email: user.email, kind, token };
  });
  const link = passwordLink(token, kind);
  if (!(await emailPasswordLink(email, kind, staff.full_name, staff.role, link))) {
    throw apiError(502, "Couldn't send the email. Try again.", 'auth_failed');
  }
  return { user_id: userId, link: smtpConfigured() ? undefined : link };
}

async function updateProfile(s: StaffCall): Promise<StaffResult> {
  const userId = requireUuid(s.body.user_id, 'user_id', 'Staff member not found.');
  const patch: { full_name?: string; phone?: string | null } = {};
  if (s.body.full_name !== undefined) patch.full_name = parseName(s.body.full_name);
  if (s.body.phone !== undefined && s.body.phone !== null) patch.phone = parsePhone(s.body.phone);
  else if (s.body.phone === null) patch.phone = null;

  tx(() => {
    const staff = loadStaff(userId);
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch) as Array<[keyof typeof patch, string | null]>) {
      if (staff[k] !== v) {
        before[k] = staff[k];
        after[k] = v;
      }
    }
    if (Object.keys(after).length === 0) return;
    updateRow(s.ctx, 'staff_profiles', userId, after, { audit: false });
    audit(s, 'staff.update_profile', userId, before, after);
  });
  return { user_id: userId };
}

const STAFF_ACTIONS: Record<string, (s: StaffCall) => Promise<StaffResult>> = {
  invite,
  set_role: setRole,
  deactivate,
  reactivate,
  resend_invite: resendInvite,
  update_profile: updateProfile,
};

functionRoutes.post('/admin-staff', async (c) => {
  const ctx = requireUser(c);
  requireRole(ctx, ['owner']);
  const body = await readJson(c);
  const action = str(body.action);
  if (!Object.hasOwn(STAFF_ACTIONS, action)) throw apiError(400, 'Unknown action.', 'invalid_action');
  const result = await STAFF_ACTIONS[action]({ ctx, body });
  return json(c, { ok: true, ...result });
});

// ================================================================== anything else

const KNOWN = new Set(['submit-booking', 'document-upload', 'document-view-url', 'create-upload-link', 'customer-upload', 'retention-purge', 'admin-staff']);

functionRoutes.all('*', (c) => {
  const name = c.req.path.split('/').filter(Boolean).pop() ?? '';
  if (KNOWN.has(name)) throw apiError(405, 'Method not allowed.', 'method_not_allowed');
  throw apiError(404, 'Not found.', 'not_found');
});
