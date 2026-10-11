// Document centre (6.8) — port of the document functions in supabase/migrations/
// 20261011000400_documents_customers.sql and 20261011001000_document_access.sql.
// Visibility (can_view_document / can_download_document) lives in server/access/scope.ts.
import { DOC_OWNER_TYPES, VERIFICATION_METHODS, type AppRole, type DocOwnerType } from '../../shared/constants.ts';
import { maskDocNumber } from '../../shared/documents.ts';
import { istDateIso, MS_DAY } from '../../shared/time.ts';
import { looksLikeFullAadhaar, normalizeDl } from '../../shared/validation.ts';
import type { DocumentRow, DocumentType } from '../../src/types/db.ts';
import { isOwner, isOwnerOrManager, isStaffRole, type Ctx } from '../access/context.ts';
import { canDownloadDocument, canSeeBooking, canViewDocument, customerHasBookingToday, documentVisibleSql } from '../access/scope.ts';
import { writeAudit } from '../audit.ts';
import { all, nowIso, one, run } from '../db/connection.ts';
import { decodeRow } from '../db/registry.ts';
import { getRow, insertRow, updateRow } from '../db/write.ts';
import { fail } from '../errors.ts';
import { retentionSetting } from '../settings.ts';
import { bool, date, oneOf, str } from './args.ts';
import { defineRpc } from './registry.ts';

export interface RegisterDocumentInput {
  /** Who uploaded it (null for customer self-upload). */
  actorId: string | null;
  ownerType: DocOwnerType;
  ownerId: string | null;
  docType: string;
  storagePath: string;
  originalFilename: string;
  mime: string;
  size: number;
  sha256: string;
  docNumber?: string | null;
  issueDate?: string | null;
  expiryDate?: string | null;
  notes?: string | null;
  replacesId?: string | null;
  aadhaarMaskedConfirmed?: boolean;
  uploadedVia: 'admin' | 'customer_link';
  uploadLinkId?: string | null;
  contextBookingId?: string | null;
}

export interface DocumentAccessInfo {
  can_view: boolean;
  can_download: boolean;
  is_kyc?: boolean;
  label?: string;
  storage_path?: string;
  original_filename?: string;
  mime_type?: string;
  deleted?: boolean;
}

// ------------------------------------------------------------------ helpers
const NOT_FOUND = 'Document not found.';

/** Types where a 12-digit number would be a full Aadhaar number (AC-03). */
const AADHAAR_NUMBER_TYPES = ['aadhaar_masked', 'other_photo_id'];

const isBlank = (v: string | null | undefined) => (v ?? '').trim() === '';

/** normalize_dl(): upper case without spaces, slashes or hyphens; null when blank. */
const normalizeDlOrNull = (v: string | null) => (v ? normalizeDl(v) || null : null);

function documentType(key: string): DocumentType | undefined {
  return decodeRow<DocumentType>('document_types', one('SELECT * FROM document_types WHERE key = ?', key));
}

const getDocument = (id: string | null) => (id ? getRow<DocumentRow>('documents', id) : undefined);

/** A document the caller may see and that is not soft-deleted (the "for update" lookups). */
function visibleLiveDocument(ctx: Ctx, id: string | null): DocumentRow {
  const d = getDocument(id);
  if (!d || !canViewDocument(ctx, d.id) || d.deleted_at !== null) fail(NOT_FOUND, 'not_found', undefined, 404);
  return d;
}

// ------------------------------------------------------------------ upload
/** can_upload_document: the caller's own role and scope (used by the upload route). */
export function canUploadDocument(ctx: Ctx, ownerType: DocOwnerType, ownerId: string | null, docType: string): boolean {
  // Scheduled jobs and internal calls act with Owner rights.
  const role: AppRole | null = ctx.system ? 'owner' : ctx.role;
  if (!role) return false;
  const t = documentType(docType);
  if (!t || !t.active || t.owner_type !== ownerType || !t.view_roles.includes(role)) return false;
  switch (ownerType) {
    case 'customer':
      return (
        Boolean(ownerId && one('SELECT 1 FROM customers WHERE id = ? AND erased_at IS NULL', ownerId)) &&
        (role !== 'staff' || customerHasBookingToday(ownerId!))
      );
    case 'booking':
      return Boolean(ownerId) && canSeeBooking(ctx, ownerId!);
    case 'car':
      return (role === 'owner' || role === 'manager') && Boolean(ownerId && one('SELECT 1 FROM cars WHERE id = ?', ownerId));
    case 'business':
      return role === 'owner';
    default:
      return false;
  }
}

/**
 * _register_document: record a file that has been checked and stored. Handles versioning
 * (DOC-11), the Aadhaar safeguards (DOC-10, AC-03), the initial status and the audit entry
 * (DOC-07). Called by the upload routes after storing the file.
 */
export function registerDocument(ctx: Ctx, input: RegisterDocumentInput): DocumentRow {
  const t = documentType(input.docType);
  if (!t || !t.active || t.owner_type !== input.ownerType) fail('Choose a document type that fits.', 'doc_type');
  if (input.ownerType !== 'business' && !input.ownerId) fail('Choose what this document belongs to.', 'owner');
  // DOC-10: never store an unmasked Aadhaar.
  if (input.docType === 'aadhaar_masked' && !input.aadhaarMaskedConfirmed) {
    fail('Confirm that only the last 4 digits of the Aadhaar number are visible.', 'aadhaar_mask');
  }
  if (input.docNumber != null && looksLikeFullAadhaar(input.docNumber) && AADHAAR_NUMBER_TYPES.includes(input.docType)) {
    fail("Don't enter a full Aadhaar number. Leave the number blank.", 'doc_number');
  }
  const issue = input.issueDate || null;
  const expiry = input.expiryDate || null;
  if (t.expiry_required && !expiry) fail('Enter the expiry date.', 'expiry_date');
  if (issue && expiry && expiry < issue) fail('The expiry date is before the issue date.', 'expiry_date');

  // DOC-11: a new version supersedes the current one (same type and owner, not deleted or already replaced).
  let old: DocumentRow | undefined;
  if (input.replacesId) {
    old = getDocument(input.replacesId);
    const owner = input.ownerType === 'business' ? null : (input.ownerId ?? null);
    if (
      !old ||
      old.deleted_at !== null ||
      old.status === 'superseded' ||
      old.doc_type !== input.docType ||
      old.owner_type !== input.ownerType ||
      (old.owner_id ?? null) !== owner
    ) {
      fail("The document being replaced doesn't match.", 'replaces');
    }
    updateRow(ctx, 'documents', old.id, { status: 'superseded' });
  }

  const status = t.tracks_expiry && expiry && expiry < istDateIso() ? 'expired' : t.is_kyc ? 'pending' : 'verified';

  const doc = insertRow<DocumentRow>(ctx, 'documents', {
    owner_type: input.ownerType,
    customer_id: input.ownerType === 'customer' ? input.ownerId : null,
    booking_id:
      input.ownerType === 'booking' ? input.ownerId : input.ownerType === 'customer' ? (input.contextBookingId ?? null) : null,
    car_id: input.ownerType === 'car' ? input.ownerId : null,
    doc_type: input.docType,
    storage_path: input.storagePath,
    original_filename: [...input.originalFilename].slice(0, 255).join(''),
    mime_type: input.mime,
    size_bytes: input.size,
    sha256: input.sha256,
    doc_number_masked: maskDocNumber(input.docNumber),
    issue_date: issue,
    expiry_date: expiry,
    notes: input.notes ?? '',
    status,
    version: (old?.version ?? 0) + 1,
    replaces_id: input.replacesId ?? null,
    aadhaar_masked_confirmed: input.aadhaarMaskedConfirmed ?? false,
    uploaded_by: input.actorId,
    uploaded_via: input.uploadedVia,
    upload_link_id: input.uploadLinkId ?? null,
  });

  writeAudit(
    ctx,
    input.replacesId ? 'document.replace' : 'document.upload',
    'documents',
    doc.id,
    null,
    {
      doc_type: input.docType,
      owner_type: input.ownerType,
      owner_id: input.ownerId,
      version: doc.version,
      replaces: input.replacesId ?? null,
      uploaded_via: input.uploadedVia,
      size_bytes: input.size,
      mime_type: input.mime,
    },
    { actorId: input.actorId ?? ctx.userId },
  );
  return doc;
}

// ------------------------------------------------------------------ view / download
/** document_access: what the caller may do with one document (used by the view-url route). */
export function documentAccess(ctx: Ctx, documentId: string): DocumentAccessInfo {
  const d = getDocument(documentId);
  if (!d || !canViewDocument(ctx, d.id)) return { can_view: false, can_download: false };
  const t = documentType(d.doc_type);
  return {
    can_view: true,
    can_download: canDownloadDocument(ctx, d.id),
    is_kyc: t?.is_kyc ?? false,
    label: t?.label,
    storage_path: d.storage_path,
    original_filename: d.original_filename,
    mime_type: d.mime_type,
    deleted: d.deleted_at !== null,
  };
}

/** _log_document_access: audit 'document.view' / 'document.download' (DOC-07, AC-08). */
export function logDocumentAccess(ctx: Ctx, documentId: string, action: 'document.view' | 'document.download'): void {
  const d = one<{ doc_type: string; owner_type: DocOwnerType; owner_id: string | null }>(
    'SELECT doc_type, owner_type, owner_id FROM documents WHERE id = ?',
    documentId,
  );
  writeAudit(ctx, action, 'documents', documentId, null, d ? { doc_type: d.doc_type, owner_type: d.owner_type, owner_id: d.owner_id } : null);
}

/** document_duplicates: same SHA-256 fingerprint (DOC-04), limited to what the caller can see. */
export function documentDuplicates(
  ctx: Ctx,
  sha256: string,
): Array<{ id: string; doc_type: string; owner_type: DocOwnerType; owner_id: string | null; created_at: string }> {
  const v = documentVisibleSql(ctx, 'd');
  return all(
    `SELECT d.id, d.doc_type, d.owner_type, d.owner_id, d.created_at
       FROM documents d
      WHERE d.sha256 = ? AND d.deleted_at IS NULL AND (${v.sql})
      ORDER BY d.created_at DESC
      LIMIT 10`,
    (sha256 ?? '').toLowerCase(),
    ...v.params,
  );
}

// ------------------------------------------------------------------ retention (10.4, AC-12)
/** _retention_due: documents whose time is up and that are not on hold. */
export function retentionDue(limit: number): Array<{ id: string; storage_path: string; reason: 'deleted' | 'retention' }> {
  return all(
    `SELECT d.id, d.storage_path, CASE WHEN d.deleted_at IS NOT NULL THEN 'deleted' ELSE 'retention' END AS reason
       FROM documents d
      WHERE d.retain_until IS NOT NULL
        AND d.retain_until <= ?
        AND d.legal_hold = 0
        AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = d.booking_id AND b.on_hold = 1)
        AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.customer_id = d.customer_id AND b.on_hold = 1)
      ORDER BY d.retain_until
      LIMIT ?`,
    nowIso(),
    Math.max(0, Math.trunc(limit)),
  );
}

/** _erase_document: remove the row once its file is gone; the audit entry records the erasure (AC-12). */
export function eraseDocumentRow(ctx: Ctx, documentId: string, reason: string): void {
  const d = getDocument(documentId);
  if (!d) return;
  run('DELETE FROM documents WHERE id = ?', d.id);
  writeAudit(ctx, 'document.erase', 'documents', d.id, null, {
    doc_type: d.doc_type,
    owner_type: d.owner_type,
    owner_id: d.owner_id,
    reason,
  });
}

// ------------------------------------------------------------------ RPCs
defineRpc('can_upload_document', 'user', (ctx, a) => {
  const ownerType = oneOf(a, 'p_owner_type', DOC_OWNER_TYPES);
  if (!ownerType) return false;
  return canUploadDocument(ctx, ownerType, str(a, 'p_owner_id'), str(a, 'p_doc_type') ?? '');
});

// Mark a customer ID document Verified or Rejected; a verified licence front updates the
// customer's licence expiry and number (pickup gate, 6.10).
defineRpc('verify_document', 'user', (ctx, a) => {
  const status = str(a, 'p_status');
  const method = oneOf(a, 'p_method', VERIFICATION_METHODS);
  const reason = str(a, 'p_reason');
  const docNumber = str(a, 'p_doc_number');
  const expiryArg = date(a, 'p_expiry_date');

  const d = visibleLiveDocument(ctx, str(a, 'p_doc'));
  const t = documentType(d.doc_type);
  if (!t?.is_kyc) fail('Only customer ID documents need verification.', 'invalid');
  if (d.status === 'superseded') fail('This is an old version. Verify the current one.', 'state');
  const expiry = expiryArg ?? d.expiry_date;

  if (status === 'verified') {
    if (!method) fail('Choose how you verified it.', 'method');
    if (d.doc_type === 'dl_front' && !expiry) fail('Enter the licence expiry date.', 'expiry_date');
    if (expiry && expiry < istDateIso()) fail('This document has expired. Reject it, or upload a current one.', 'expiry_date');
  } else if (status === 'rejected') {
    if (isBlank(reason)) fail('Give a reason for rejecting it.', 'reason');
  } else {
    fail('Mark the document Verified or Rejected.', 'invalid');
  }

  const updated = updateRow<DocumentRow>(ctx, 'documents', d.id, {
    status,
    verification_method: status === 'verified' ? method : null,
    verified_by: ctx.userId,
    verified_at: nowIso(),
    reject_reason: status === 'rejected' ? reason!.trim() : null,
    expiry_date: expiry,
    doc_number_masked: maskDocNumber(docNumber) ?? d.doc_number_masked,
  })!;

  if (updated.doc_type === 'dl_front' && status === 'verified' && updated.customer_id) {
    const customer = getRow<{ dl_number: string | null }>('customers', updated.customer_id);
    if (customer) {
      updateRow(ctx, 'customers', updated.customer_id, {
        dl_expiry: expiry,
        dl_number: normalizeDlOrNull(docNumber) ?? customer.dl_number,
      });
    }
  }

  writeAudit(ctx, status === 'verified' ? 'document.verify' : 'document.reject', 'documents', updated.id, null, {
    doc_type: updated.doc_type,
    method,
    reason,
    expiry_date: expiry,
  });
  return updated;
});

defineRpc('update_document_details', 'user', (ctx, a) => {
  const issueArg = date(a, 'p_issue_date');
  const expiryArg = date(a, 'p_expiry_date');
  const notesArg = str(a, 'p_notes');
  const docNumber = str(a, 'p_doc_number');

  const d = visibleLiveDocument(ctx, str(a, 'p_doc'));
  if (isStaffRole(ctx) && d.owner_type !== 'customer') fail('Not allowed.', 'forbidden', undefined, 403);

  const before = { issue_date: d.issue_date, expiry_date: d.expiry_date, notes: d.notes };
  const expiry = expiryArg ?? d.expiry_date;
  const today = istDateIso();
  // An expiry date in the past marks the document Expired; a renewed date brings it back (DOC-12).
  let status = d.status;
  if ((d.status === 'pending' || d.status === 'verified') && expiry !== null && expiry < today) status = 'expired';
  else if (d.status === 'expired' && expiry !== null && expiry >= today) status = documentType(d.doc_type)?.is_kyc ? 'pending' : 'verified';

  const updated = updateRow<DocumentRow>(ctx, 'documents', d.id, {
    issue_date: issueArg ?? d.issue_date,
    expiry_date: expiry,
    notes: notesArg ?? d.notes,
    doc_number_masked: maskDocNumber(docNumber) ?? d.doc_number_masked,
    status,
  })!;
  writeAudit(ctx, 'document.update', 'documents', updated.id, before, {
    issue_date: updated.issue_date,
    expiry_date: updated.expiry_date,
    notes: updated.notes,
  });
  return updated;
});

// DOC-15: Owner only, soft delete with a reason; erased permanently after the grace period.
defineRpc('soft_delete_document', 'user', (ctx, a) => {
  if (!isOwner(ctx)) fail('Only the Owner can delete documents.', 'forbidden', undefined, 403);
  const reason = str(a, 'p_reason');
  if (isBlank(reason)) fail('Give a reason for deleting it.', 'reason');
  const d = getDocument(str(a, 'p_doc'));
  if (!d || d.deleted_at !== null) fail(NOT_FOUND, 'not_found', undefined, 404);
  const now = Date.now();
  const updated = updateRow<DocumentRow>(ctx, 'documents', d.id, {
    deleted_at: new Date(now).toISOString(),
    deleted_by: ctx.userId,
    delete_reason: reason!.trim(),
    retain_until: new Date(now + retentionSetting('soft_delete_days', 30) * MS_DAY).toISOString(),
  })!;
  writeAudit(ctx, 'document.delete', 'documents', updated.id, null, {
    doc_type: updated.doc_type,
    reason,
    erase_after: updated.retain_until,
  });
  return null;
});

defineRpc('restore_document', 'user', (ctx, a) => {
  if (!isOwner(ctx)) fail('Only the Owner can restore documents.', 'forbidden', undefined, 403);
  const d = getDocument(str(a, 'p_doc'));
  if (!d || d.deleted_at === null) fail('Document not found, or already erased.', 'not_found', undefined, 404);
  updateRow(ctx, 'documents', d.id, { deleted_at: null, deleted_by: null, delete_reason: null, retain_until: null });
  writeAudit(ctx, 'document.restore', 'documents', d.id, null, { doc_type: d.doc_type });
  return null;
});

// Legal hold: an open fine, claim or dispute keeps the document past its retention date (10.4).
defineRpc('set_document_hold', 'user', (ctx, a) => {
  if (!isOwnerOrManager(ctx)) fail('Not allowed.', 'forbidden', undefined, 403);
  const id = str(a, 'p_doc');
  const hold = bool(a, 'p_hold');
  const reason = str(a, 'p_reason');
  if (hold && isBlank(reason)) fail('Give a reason for the hold.', 'reason');
  if (id && getDocument(id)) updateRow(ctx, 'documents', id, { legal_hold: hold, hold_reason: hold ? reason!.trim() : null });
  writeAudit(ctx, hold ? 'document.hold' : 'document.release', 'documents', id, null, { reason });
  return null;
});

defineRpc('document_duplicates', 'user', (ctx, a) => documentDuplicates(ctx, str(a, 'p_sha256') ?? ''));

defineRpc('document_access', 'user', (ctx, a) => documentAccess(ctx, str(a, 'p_doc') ?? ''));
