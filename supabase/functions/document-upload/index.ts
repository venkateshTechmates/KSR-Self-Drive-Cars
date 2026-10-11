// document-upload (admin, P0; DOC-01..04, DOC-07, DOC-10, DOC-11).
// POST multipart/form-data:
//   file, owner_type ('customer'|'booking'|'car'|'business'), owner_id (omit for business),
//   doc_type, sha256 (client-computed hex), doc_number?, issue_date?, expiry_date?, notes?,
//   replaces_id?, aadhaar_masked_confirmed ('true'), context_booking_id?
// 200 { document: <documents row>, duplicates: [{ id, doc_type, owner_type, owner_id, created_at }] }
// 403 "You can't upload this document here."   409 { code: 'duplicate' }   400/413/415 file problems
import { DOC_OWNER_TYPES, type DocOwnerType } from '../_shared/domain/constants.ts';
import { isIsoDate } from '../_shared/domain/time.ts';
import { requireRole, requireUser, serviceClient } from '../_shared/clients.ts';
import {
  checkFile,
  documentStoragePath,
  FILE_MESSAGES,
  formFile,
  removeDocumentFiles,
  storeDocumentFile,
} from '../_shared/files.ts';
import { allowMethods, enforceBodyLimit, fromPgError, handler, HttpError, json, optStr, optUuid, readForm, str } from '../_shared/http.ts';
import { clientIp, userAgent } from '../_shared/request.ts';

const DOC_TYPE_RE = /^[a-z][a-z0-9_]{1,40}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
/** One file of up to 10 MB plus form fields and multipart overhead. */
const MAX_BODY_BYTES = 11 * 1024 * 1024;

function invalid(field: string, message: string): HttpError {
  return new HttpError(422, message, 'validation', { [field]: message });
}

function optDate(value: unknown, field: string): string | null {
  const s = optStr(value);
  if (s === null) return null;
  if (!isIsoDate(s)) throw invalid(field, 'Enter a valid date.');
  return s;
}

Deno.serve(
  handler('document-upload', async (req) => {
    allowMethods(req, ['POST']);
    const ctx = await requireUser(req);
    requireRole(ctx);
    enforceBodyLimit(req, MAX_BODY_BYTES);
    const form = await readForm(req);

    // ------------------------------------------------------------ fields
    const ownerTypeRaw = str(form.get('owner_type'));
    if (!(DOC_OWNER_TYPES as readonly string[]).includes(ownerTypeRaw)) {
      throw invalid('owner_type', 'Choose what this document belongs to.');
    }
    const ownerType = ownerTypeRaw as DocOwnerType;
    const ownerId = ownerType === 'business' ? null : optUuid(form.get('owner_id'), 'owner_id');
    if (ownerType !== 'business' && !ownerId) throw invalid('owner_id', 'Choose what this document belongs to.');

    const docType = str(form.get('doc_type'));
    if (!DOC_TYPE_RE.test(docType)) throw invalid('doc_type', 'Choose a document type.');

    const clientSha = str(form.get('sha256')).toLowerCase();
    if (!SHA_RE.test(clientSha)) throw new HttpError(400, 'The file fingerprint is missing. Try again.', 'checksum_missing');

    const docNumber = optStr(form.get('doc_number'));
    if (docNumber && docNumber.replace(/\s/g, '').length > 40) throw invalid('doc_number', 'The document number is too long.');
    const issueDate = optDate(form.get('issue_date'), 'issue_date');
    const expiryDate = optDate(form.get('expiry_date'), 'expiry_date');
    const notes = (optStr(form.get('notes')) ?? '').slice(0, 2000);
    const replacesId = optUuid(form.get('replaces_id'), 'replaces_id');
    const aadhaarMaskedConfirmed = str(form.get('aadhaar_masked_confirmed')) === 'true';
    // Only customer documents carry the booking they were uploaded in.
    const contextBookingId = ownerType === 'customer' ? optUuid(form.get('context_booking_id'), 'context_booking_id') : null;

    // ------------------------------------------------------------ permission (caller's own role and scope)
    const { data: canUpload, error: canError } = await ctx.client.rpc('can_upload_document', {
      p_owner_type: ownerType,
      p_owner_id: ownerId,
      p_doc_type: docType,
    });
    if (canError) throw fromPgError(canError, 'document-upload');
    if (canUpload !== true) throw new HttpError(403, "You can't upload this document here.", 'forbidden');

    const service = serviceClient();
    if (contextBookingId) {
      const { data: booking, error } = await service
        .from('bookings')
        .select('id, customer_id')
        .eq('id', contextBookingId)
        .maybeSingle();
      if (error) throw fromPgError(error, 'document-upload');
      if (!booking || booking.customer_id !== ownerId) {
        throw invalid('context_booking_id', "This booking isn't for this customer.");
      }
    }

    // ------------------------------------------------------------ file
    const upload = formFile(form, 'file');
    if (!upload) throw new HttpError(400, FILE_MESSAGES.missing, 'file_missing');
    const file = await checkFile(upload, undefined, docType);
    if (file.sha256 !== clientSha) {
      throw new HttpError(400, 'The file changed during upload. Try again.', 'checksum_mismatch');
    }

    // Same file already saved for the same owner and type (DOC-04).
    let dupQuery = service
      .from('documents')
      .select('id')
      .eq('sha256', file.sha256)
      .eq('doc_type', docType)
      .eq('owner_type', ownerType)
      .is('deleted_at', null)
      .limit(1);
    if (ownerId) dupQuery = dupQuery.eq('owner_id', ownerId);
    const { data: existing, error: dupError } = await dupQuery;
    if (dupError) throw fromPgError(dupError, 'document-upload');
    if (existing && existing.length > 0) {
      throw new HttpError(409, 'This file is already uploaded here.', 'duplicate', { document_id: existing[0].id });
    }

    // ------------------------------------------------------------ store, then register
    const path = documentStoragePath(ownerType, ownerId, docType, crypto.randomUUID(), file.ext);
    await storeDocumentFile(service, path, file);

    const { data: doc, error: regError } = await service.rpc('_register_document', {
      p_actor: ctx.user.id,
      p_owner_type: ownerType,
      p_owner_id: ownerId,
      p_doc_type: docType,
      p_storage_path: path,
      p_original_filename: file.filename,
      p_mime: file.mime,
      p_size: file.size,
      p_sha256: file.sha256,
      p_doc_number: docNumber,
      p_issue: issueDate,
      p_expiry: expiryDate,
      p_notes: notes,
      p_replaces: replacesId,
      p_aadhaar_masked_confirmed: aadhaarMaskedConfirmed,
      p_uploaded_via: 'admin',
      p_upload_link: null,
      p_context_booking: contextBookingId,
      p_ip: clientIp(req),
      p_user_agent: userAgent(req),
    });
    if (regError || !doc) {
      await removeDocumentFiles(service, [path]);
      if (regError) throw fromPgError(regError, 'document-upload');
      throw new HttpError(500, "Couldn't save the document. Try again.", 'internal');
    }
    const document = doc as { id: string };

    // Same fingerprint elsewhere, limited to what this user may see.
    const { data: dups, error: dupsError } = await ctx.client.rpc('document_duplicates', { p_sha256: file.sha256 });
    if (dupsError) console.error('[document-upload] duplicate lookup failed', dupsError.code ?? '', dupsError.message ?? '');
    const duplicates = ((dups ?? []) as Array<{ id: string }>).filter((d) => d.id !== document.id);

    return json({ document, duplicates });
  }),
);
