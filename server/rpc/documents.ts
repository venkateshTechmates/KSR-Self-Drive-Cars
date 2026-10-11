// Document centre (6.8) — port of the document functions in supabase/migrations/
// 20261011000400_documents_customers.sql and 20261011001000_document_access.sql.
// CONTRACT STUB: implement the exported functions and register the RPCs listed below.
import type { DocOwnerType } from '../../shared/constants.ts';
import type { Ctx } from '../access/context.ts';
import type { DocumentRow } from '../../src/types/db.ts';

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

/** can_upload_document */
export function canUploadDocument(_ctx: Ctx, _ownerType: DocOwnerType, _ownerId: string | null, _docType: string): boolean {
  throw new Error('not implemented');
}

/** _register_document: versioning (DOC-11), DOC-10 checks, status, audit 'document.upload'/'document.replace'. */
export function registerDocument(_ctx: Ctx, _input: RegisterDocumentInput): DocumentRow {
  throw new Error('not implemented');
}

/** document_access */
export function documentAccess(_ctx: Ctx, _documentId: string): DocumentAccessInfo {
  throw new Error('not implemented');
}

/** _log_document_access: audit 'document.view' / 'document.download' (DOC-07, AC-08). */
export function logDocumentAccess(_ctx: Ctx, _documentId: string, _action: 'document.view' | 'document.download'): void {
  throw new Error('not implemented');
}

/** document_duplicates (visible to the caller). */
export function documentDuplicates(_ctx: Ctx, _sha256: string): Array<{ id: string; doc_type: string; owner_type: DocOwnerType; owner_id: string | null; created_at: string }> {
  throw new Error('not implemented');
}

/** _retention_due: documents whose time is up and that are not on hold. */
export function retentionDue(_limit: number): Array<{ id: string; storage_path: string; reason: 'deleted' | 'retention' }> {
  throw new Error('not implemented');
}

/** _erase_document: delete the row after its file is gone; audit 'document.erase' (AC-12). */
export function eraseDocumentRow(_ctx: Ctx, _documentId: string, _reason: string): void {
  throw new Error('not implemented');
}

/*
RPCs to register (user): can_upload_document, verify_document, update_document_details,
  soft_delete_document, restore_document, set_document_hold, document_duplicates, document_access
*/
