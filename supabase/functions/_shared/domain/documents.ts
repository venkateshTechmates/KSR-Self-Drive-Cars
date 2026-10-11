// Document rules from Section 6.8 (DOC-03, DOC-04, DOC-12) shared by the admin
// uploader and the upload edge functions.
import { daysBetween } from './time.ts';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Images larger than this on either side are resized before upload (DOC-03). */
export const MAX_IMAGE_DIMENSION = 2500;
export const EXPIRING_SOON_DAYS = 30;
export const SIGNED_URL_SECONDS = 300;
export const MAX_CAR_PHOTOS = 8;

/** Types accepted from the picker. HEIC/HEIF is converted to JPG in the browser before upload. */
export const ACCEPTED_DOC_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];
export const ACCEPT_ATTR = '.jpg,.jpeg,.png,.webp,.heic,.heif,.pdf,image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf';
/** Types the server stores (after browser-side HEIC conversion). */
export const STORED_DOC_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export type StoredDocMime = (typeof STORED_DOC_MIME)[number];

export const EXT_FOR_MIME: Record<StoredDocMime, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

const startsWith = (b: Uint8Array, sig: number[], offset = 0) => sig.every((v, i) => b[offset + i] === v);
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

/**
 * Detect a file's real type from its first bytes, not its name (Section 10.5).
 * Returns null for anything that is not an allowed type.
 */
export function sniffMime(bytes: Uint8Array): StoredDocMime | 'image/heic' | null {
  if (bytes.length < 12) return null;
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp';
  if (ascii(bytes, 0, 5) === '%PDF-') return 'application/pdf';
  if (ascii(bytes, 4, 8) === 'ftyp' && /^(heic|heix|hevc|hevx|mif1|msf1)$/.test(ascii(bytes, 8, 12))) return 'image/heic';
  return null;
}

export type ExpiryState = 'valid' | 'expiring_soon' | 'expired';

export const EXPIRY_LABELS: Record<ExpiryState, string> = {
  valid: 'Valid',
  expiring_soon: 'Expiring soon',
  expired: 'Expired',
};

/** Valid / Expiring soon (within 30 days) / Expired (DOC-12). `todayIso` is the IST date. */
export function expiryState(expiryIso: string | null | undefined, todayIso: string): ExpiryState | null {
  if (!expiryIso) return null;
  const days = daysBetween(todayIso, expiryIso);
  if (days < 0) return 'expired';
  if (days <= EXPIRING_SOON_DAYS) return 'expiring_soon';
  return 'valid';
}

/** Keep only the last 4 characters visible, e.g. "XXXXXXXXXXX2345". */
export function maskDocNumber(value: string | null | undefined, visible = 4): string | null {
  const v = (value ?? '').replace(/\s/g, '');
  if (!v) return null;
  if (v.length <= visible) return v;
  return 'X'.repeat(v.length - visible) + v.slice(-visible);
}

/** Hex SHA-256 of a byte array, using Web Crypto (browser and Deno). */
export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = await crypto.subtle.digest('SHA-256', buf as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Document types whose expiry, once passed, blocks confirming a booking for the car (FLT-08). */
export const BLOCKING_VEHICLE_DOC_TYPES = ['insurance', 'puc', 'permit'] as const;
/** Customer KYC document types (Section 6.8.1). */
export const KYC_DOC_TYPES = ['dl_front', 'dl_back', 'aadhaar_masked', 'other_photo_id', 'customer_photo'] as const;
/** Types a customer may send through a self-upload link (DOC-16). */
export const SELF_UPLOAD_DOC_TYPES = ['dl_front', 'dl_back', 'aadhaar_masked', 'other_photo_id'] as const;
