// Client side of the document centre: upload through the document-upload edge function and
// open files through short-lived signed links from document-view-url (DOC-05, DOC-07).
import type { DocOwnerType } from '@shared/constants.ts';
import { sha256Hex } from '@shared/documents.ts';
import type { DocumentRow } from '@/types/db';
import { callFunction } from './functions';
import { prepareDocumentFile } from './images';
import { saveFromUrl } from './download';

export interface UploadDocumentInput {
  ownerType: DocOwnerType;
  /** Customer, booking or car id. Omit for business documents. */
  ownerId?: string | null;
  docType: string;
  file: File;
  docNumber?: string;
  issueDate?: string;
  expiryDate?: string;
  notes?: string;
  replacesId?: string | null;
  /** Required for aadhaar_masked (DOC-10). */
  aadhaarMaskedConfirmed?: boolean;
  /** Booking the upload happened in, for customer documents uploaded at a pickup. */
  contextBookingId?: string | null;
  /** Skip browser-side processing (the file was already prepared, e.g. a redacted image). */
  prepared?: boolean;
}

export interface UploadDocumentResult {
  document: DocumentRow;
  duplicates: Array<{ id: string; doc_type: string; owner_type: DocOwnerType; owner_id: string | null }>;
}

export async function uploadDocument(input: UploadDocumentInput): Promise<UploadDocumentResult> {
  const prepared = input.prepared
    ? { blob: input.file as Blob, name: input.file.name, mime: input.file.type }
    : await prepareDocumentFile(input.file);
  const sha256 = await sha256Hex(await prepared.blob.arrayBuffer());
  const form = new FormData();
  form.set('file', prepared.blob, prepared.name);
  form.set('owner_type', input.ownerType);
  if (input.ownerId) form.set('owner_id', input.ownerId);
  form.set('doc_type', input.docType);
  form.set('sha256', sha256);
  if (input.docNumber) form.set('doc_number', input.docNumber);
  if (input.issueDate) form.set('issue_date', input.issueDate);
  if (input.expiryDate) form.set('expiry_date', input.expiryDate);
  if (input.notes) form.set('notes', input.notes);
  if (input.replacesId) form.set('replaces_id', input.replacesId);
  if (input.aadhaarMaskedConfirmed) form.set('aadhaar_masked_confirmed', 'true');
  if (input.contextBookingId) form.set('context_booking_id', input.contextBookingId);
  return callFunction<UploadDocumentResult>('document-upload', { formData: form });
}

export interface SignedDocumentUrl {
  url: string;
  expires_at: string;
  filename: string;
  mime_type: string;
  watermark: string | null;
}

/** A 5-minute signed link. Every call is written to the audit log by the server. */
export function getDocumentUrl(documentId: string, opts: { download?: boolean } = {}): Promise<SignedDocumentUrl> {
  return callFunction<SignedDocumentUrl>('document-view-url', {
    body: { document_id: documentId, download: Boolean(opts.download) },
  });
}

/** Download through a signed link, keeping the original file name (share sheet in the app). */
export async function downloadDocument(documentId: string): Promise<void> {
  const signed = await getDocumentUrl(documentId, { download: true });
  await saveFromUrl(signed.url, signed.filename);
}

export interface UploadLinkResult {
  url: string;
  expires_at: string;
  message: string;
}

/** DOC-16: one-time customer upload link (valid 24 hours). */
export function createUploadLink(customerId: string, bookingId?: string | null): Promise<UploadLinkResult> {
  return callFunction<UploadLinkResult>('create-upload-link', { body: { customer_id: customerId, booking_id: bookingId ?? null } });
}
