// customer-upload (public, P1; DOC-16). The customer opens /upload/{token} from a one-time link.
// GET  ?token=…  200 { valid: true, first_name, expires_at, business_name, doc_types: [{ key, label }] }
// POST multipart: token, consent ('true'), aadhaar_masked_confirmed ('true' if file_aadhaar_masked),
//      locale?, file_dl_front?, file_dl_back?, file_aadhaar_masked?, file_other_photo_id? (at least one)
//      200 { ok: true, uploaded: <count> }
// 410 { error: 'This link has expired or was already used. Ask us for a new one.', code: 'link_invalid' }
// All files are saved, or none are: on any failure the stored files and records are rolled back
// and the link stays usable.
import { LOCALES } from '../_shared/domain/constants.ts';
import { sha256Hex, SELF_UPLOAD_DOC_TYPES } from '../_shared/domain/documents.ts';
import { MESSAGES } from '../_shared/domain/validation.ts';
import { type Client, serviceClient } from '../_shared/clients.ts';
import {
  type CheckedFile,
  checkFile,
  documentStoragePath,
  formFile,
  removeDocumentFiles,
  storeDocumentFile,
} from '../_shared/files.ts';
import {
  allowMethods,
  enforceBodyLimit,
  fromPgError,
  handler,
  HttpError,
  json,
  readForm,
  str,
} from '../_shared/http.ts';
import { drainOutboxInBackground } from '../_shared/outbox.ts';
import { clientIp, ipHash, userAgent } from '../_shared/request.ts';
import { loadSettings } from '../_shared/settings.ts';

type SelfUploadType = (typeof SELF_UPLOAD_DOC_TYPES)[number];

const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
/** Four files of up to 10 MB each plus form fields and multipart overhead. */
const MAX_BODY_BYTES = 41 * 1024 * 1024;

const linkInvalid = () =>
  new HttpError(410, 'This link has expired or was already used. Ask us for a new one.', 'link_invalid');

interface UploadLink {
  id: string;
  customer_id: string;
  booking_id: string | null;
  expires_at: string;
  used_at: string | null;
  customer: { full_name: string; erased_at: string | null } | null;
}

async function findValidLink(service: Client, token: string): Promise<UploadLink> {
  if (!TOKEN_RE.test(token)) throw linkInvalid();
  const tokenHash = await sha256Hex(new TextEncoder().encode(token));
  const { data, error } = await service
    .from('upload_links')
    .select('id, customer_id, booking_id, expires_at, used_at, customer:customers(full_name, erased_at)')
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (error) throw fromPgError(error, 'customer-upload');
  const link = data as UploadLink | null;
  if (
    !link ||
    link.used_at ||
    new Date(link.expires_at).getTime() <= Date.now() ||
    !link.customer ||
    link.customer.erased_at
  ) {
    throw linkInvalid();
  }
  return link;
}

/** Labels for the self-upload types, in display order. */
async function docTypeLabels(service: Client): Promise<Array<{ key: SelfUploadType; label: string }>> {
  const { data, error } = await service
    .from('document_types')
    .select('key, label')
    .in('key', [...SELF_UPLOAD_DOC_TYPES])
    .eq('active', true);
  if (error) throw fromPgError(error, 'customer-upload');
  const labels = new Map(((data ?? []) as Array<{ key: string; label: string }>).map((r) => [r.key, r.label]));
  return SELF_UPLOAD_DOC_TYPES.filter((k) => labels.has(k)).map((key) => ({ key, label: labels.get(key)! }));
}

const firstName = (fullName: string | undefined) => (fullName ?? '').trim().split(/\s+/)[0] ?? '';

// ---------------------------------------------------------------- GET: check the link

async function handleGet(req: Request): Promise<Response> {
  const service = serviceClient();
  const token = new URL(req.url).searchParams.get('token') ?? '';
  const link = await findValidLink(service, token);
  const [{ business }, docTypes] = await Promise.all([loadSettings(service, ['business']), docTypeLabels(service)]);
  return json({
    valid: true,
    first_name: firstName(link.customer?.full_name),
    expires_at: new Date(link.expires_at).toISOString(),
    business_name: business.name,
    doc_types: docTypes,
  });
}

// ---------------------------------------------------------------- POST: upload

async function handlePost(req: Request): Promise<Response> {
  enforceBodyLimit(req, MAX_BODY_BYTES);
  const service = serviceClient();
  const ip = clientIp(req);
  const ua = userAgent(req);

  const { data: allowed, error: limitError } = await service.rpc('_register_submission', {
    p_kind: 'upload',
    p_phone: null,
    p_ip_hash: await ipHash(ip),
    p_max_phone: 0,
    p_max_ip: 20,
  });
  if (limitError) throw fromPgError(limitError, 'customer-upload');
  if (allowed !== true) throw new HttpError(429, MESSAGES.tooManyRequests, 'rate_limited');

  const form = await readForm(req);
  const link = await findValidLink(service, str(form.get('token')));

  if (str(form.get('consent')) !== 'true') {
    const message = 'Tick the box to agree to how we use your documents.';
    throw new HttpError(422, message, 'consent', { consent: message });
  }

  const allTypes = await docTypeLabels(service);
  const labelOf = (key: string) => allTypes.find((t) => t.key === key)?.label ?? key;
  const chosen: Array<{ docType: SelfUploadType; field: string; upload: File }> = [];
  for (const { key } of allTypes) {
    const field = `file_${key}`;
    const upload = formFile(form, field);
    if (upload) chosen.push({ docType: key, field, upload });
  }
  if (chosen.length === 0) {
    throw new HttpError(422, 'Add at least one photo or PDF.', 'no_files');
  }
  const aadhaarConfirmed = str(form.get('aadhaar_masked_confirmed')) === 'true';
  if (chosen.some((c) => c.docType === 'aadhaar_masked') && !aadhaarConfirmed) {
    const message = 'Confirm that only the last 4 digits of the Aadhaar number are visible.';
    throw new HttpError(422, message, 'aadhaar_mask', { aadhaar_masked_confirmed: message });
  }

  // Check every file before saving any.
  const files: Array<{ docType: SelfUploadType; file: CheckedFile }> = [];
  for (const c of chosen) {
    try {
      files.push({ docType: c.docType, file: await checkFile(c.upload, c.field, c.docType) });
    } catch (err) {
      if (err instanceof HttpError) {
        throw new HttpError(err.status, `${labelOf(c.docType)}: ${err.message}`, err.code, err.hint);
      }
      throw err;
    }
  }

  // Claim the link so two submissions can't both use it.
  const { data: claimed, error: claimError } = await service
    .from('upload_links')
    .update({ used_at: new Date().toISOString() })
    .eq('id', link.id)
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('id');
  if (claimError) throw fromPgError(claimError, 'customer-upload');
  if (!claimed || claimed.length === 0) throw linkInvalid();
  const releaseLink = async () => {
    const { error } = await service.from('upload_links').update({ used_at: null }).eq('id', link.id);
    if (error) console.error('[customer-upload] could not release link', error.code ?? '', error.message ?? '');
  };

  const storedPaths: string[] = [];
  const registeredIds: string[] = [];
  try {
    const localeRaw = str(form.get('locale'));
    const locale = (LOCALES as readonly string[]).includes(localeRaw) ? localeRaw : 'en';
    const { data: noticeVersion, error: noticeError } = await service.rpc('current_notice_version', { p_locale: locale });
    if (noticeError) throw fromPgError(noticeError, 'customer-upload');
    const { error: consentError } = await service.from('consents').insert({
      customer_id: link.customer_id,
      booking_id: link.booking_id,
      purpose: 'document_upload',
      notice_version: noticeVersion,
      channel: 'customer_link',
      ip,
      user_agent: ua,
    });
    if (consentError) throw fromPgError(consentError, 'customer-upload');

    for (const { docType, file } of files) {
      const path = documentStoragePath('customer', link.customer_id, docType, crypto.randomUUID(), file.ext);
      await storeDocumentFile(service, path, file);
      storedPaths.push(path);
      const { data: doc, error: regError } = await service.rpc('_register_document', {
        p_actor: null,
        p_owner_type: 'customer',
        p_owner_id: link.customer_id,
        p_doc_type: docType,
        p_storage_path: path,
        p_original_filename: file.filename,
        p_mime: file.mime,
        p_size: file.size,
        p_sha256: file.sha256,
        p_doc_number: null,
        p_issue: null,
        p_expiry: null,
        p_notes: '',
        p_replaces: null,
        p_aadhaar_masked_confirmed: docType === 'aadhaar_masked' && aadhaarConfirmed,
        p_uploaded_via: 'customer_link',
        p_upload_link: link.id,
        p_context_booking: link.booking_id,
        p_ip: ip,
        p_user_agent: ua,
      });
      if (regError) throw fromPgError(regError, 'customer-upload');
      if (doc && typeof (doc as { id?: unknown }).id === 'string') registeredIds.push((doc as { id: string }).id);
    }
  } catch (err) {
    // Roll back: files first, then their records (each erasure is audited), then free the link.
    await removeDocumentFiles(service, storedPaths);
    for (const id of registeredIds) {
      const { error } = await service.rpc('_erase_document', {
        p_doc: id,
        p_reason: 'Customer upload failed and was rolled back',
      });
      if (error) console.error('[customer-upload] rollback failed', error.code ?? '', error.message ?? '');
    }
    await releaseLink();
    throw err;
  }

  // Tell the Owner/Manager (Section 11). No personal data beyond the first name.
  try {
    const name = firstName(link.customer?.full_name) || 'A customer';
    const { data: recipients, error: recError } = await service.rpc('_recipients', { p_setting: 'upload_emails' });
    if (recError) throw recError;
    const { error: enqueueError } = await service.rpc('_enqueue_email', {
      p_kind: 'customer_upload',
      p_recipients: recipients ?? [],
      p_subject: 'Customer uploaded documents',
      p_body: [
        `${name} uploaded ${files.length} document${files.length === 1 ? '' : 's'} through an upload link:`,
        ...files.map((f) => `- ${labelOf(f.docType)}`),
        '',
        'They are Pending. Check and verify them before pickup.',
      ].join('\n'),
      p_payload: { path: `/admin/customers/${link.customer_id}` },
      p_dedupe: `customer_upload:${link.id}`,
    });
    if (enqueueError) throw enqueueError;
    drainOutboxInBackground(service, 'customer-upload');
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error('[customer-upload] could not queue the notification', e?.code ?? '', e?.message ?? '');
  }

  return json({ ok: true, uploaded: files.length });
}

Deno.serve(
  handler('customer-upload', async (req) => {
    allowMethods(req, ['GET', 'POST']);
    return req.method === 'GET' ? await handleGet(req) : await handlePost(req);
  }),
);
