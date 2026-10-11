// Uploaded-file checks and storage for the private `documents` bucket (6.8.2, 6.8.3, 10.5).
// The real type is detected from the file's first bytes, never from its name or the
// browser-supplied content type.
import type { DocOwnerType } from './domain/constants.ts';
import { EXT_FOR_MIME, MAX_UPLOAD_BYTES, sha256Hex, sniffMime, type StoredDocMime } from './domain/documents.ts';
import type { Client } from './clients.ts';
import { HttpError } from './http.ts';

export const DOCUMENTS_BUCKET = 'documents';

export const FILE_MESSAGES = {
  missing: 'Choose a file to upload.',
  empty: 'This file is empty. Choose another file.',
  tooLarge: 'This file is larger than 10 MB. Choose a smaller file or a lower-resolution photo.',
  heic: "This photo is in HEIC format and couldn't be converted. Try again, or save it as JPG first and upload that.",
  type: 'Upload a JPG, PNG, WebP or PDF file.',
} as const;

export interface CheckedFile {
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
export function formFile(form: FormData, field: string): File | null {
  const v = form.get(field);
  return v !== null && typeof v !== 'string' ? v : null;
}

function fileError(status: number, message: string, code: string, field?: string): HttpError {
  return new HttpError(status, message, code, field ? { [field]: message } : undefined);
}

/**
 * Enforce the size limit and allowed types, and fingerprint the file.
 * `field` (optional) is echoed in the error hint so a form can highlight it.
 */
export async function checkFile(file: File, field?: string, fallbackName = 'document'): Promise<CheckedFile> {
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
    sha256: await sha256Hex(bytes),
    filename: safeFilename(file.name, ext, fallbackName),
  };
}

/** Base name without folders or control characters, with an extension matching the real type. */
export function safeFilename(name: string | undefined, ext: string, fallbackBase = 'document'): string {
  const raw = (name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = [...raw].filter((c) => {
    const code = c.codePointAt(0) ?? 0;
    return code >= 32 && code !== 127;
  }).join('').trim();
  const dot = cleaned.lastIndexOf('.');
  const stem = (dot > 0 ? cleaned.slice(0, dot) : cleaned).trim() || fallbackBase;
  const current = dot > 0 ? cleaned.slice(dot + 1).toLowerCase() : '';
  const accepted = ext === 'jpg' ? ['jpg', 'jpeg'] : [ext];
  const finalExt = accepted.includes(current) ? current : ext;
  return `${[...stem].slice(0, 200).join('')}.${finalExt}`;
}

/**
 * Storage path (6.8.3). File names are random ids; the original name lives only in the database.
 *   customers/{customer_id}/{doc_type}/{id}.{ext}
 *   bookings/{booking_id}/{doc_type}/{id}.{ext}
 *   vehicles/{car_id}/{doc_type}/{id}.{ext}
 *   business/{doc_type}/{id}.{ext}
 */
export function documentStoragePath(
  ownerType: DocOwnerType,
  ownerId: string | null,
  docType: string,
  documentId: string,
  ext: string,
): string {
  if (ownerType === 'business') return `business/${docType}/${documentId}.${ext}`;
  if (!ownerId) throw new Error('ownerId is required for non-business documents');
  const folder = ownerType === 'customer' ? 'customers' : ownerType === 'booking' ? 'bookings' : 'vehicles';
  return `${folder}/${ownerId}/${docType}/${documentId}.${ext}`;
}

/** Upload to the private documents bucket (never overwrites). */
export async function storeDocumentFile(service: Client, path: string, file: CheckedFile): Promise<void> {
  const { error } = await service.storage
    .from(DOCUMENTS_BUCKET)
    .upload(path, file.bytes, { contentType: file.mime, upsert: false });
  if (error) {
    console.error('[storage] upload failed', error.name ?? 'Error', error.message ?? '');
    throw new HttpError(500, "Couldn't save the file. Try again.", 'storage');
  }
}

/** Best-effort removal (used to undo an upload whose database record failed). */
export async function removeDocumentFiles(service: Client, paths: string[]): Promise<boolean> {
  if (paths.length === 0) return true;
  try {
    const { error } = await service.storage.from(DOCUMENTS_BUCKET).remove(paths);
    if (error) {
      console.error('[storage] remove failed', error.name ?? 'Error', error.message ?? '');
      return false;
    }
    return true;
  } catch (err) {
    const e = err as { name?: string; message?: string };
    console.error('[storage] remove failed', e?.name ?? 'Error', e?.message ?? '');
    return false;
  }
}
