// Cloudinary as the file store (CLOUDINARY_URL), used by server/storage.ts.
//
//   documents    raw files, delivery type "authenticated": never public. The server fetches a
//                file with a 60-second signed download URL and streams it through
//                /api/files/<token>, so access checks, 5-minute links and the audit log of
//                every view stay exactly as they were (DOC-05, DOC-07).
//   car-photos   public images on Cloudinary's CDN; /media/car-photos/* redirects there.
//
// Raw storage keeps the bytes exactly as uploaded (the SHA-256 recorded on upload still
// matches). Files live under CLOUDINARY_FOLDER (default "ksr"), one folder per bucket.
import { config } from './config.ts';
import type { Bucket } from './storage.ts';

type Sdk = typeof import('cloudinary').v2;
let sdk: Promise<Sdk> | null = null;

/** The SDK, configured, loaded only when Cloudinary is in use. */
function client(): Promise<Sdk> {
  const c = config.cloudinary;
  if (!c) return Promise.reject(new Error('Cloudinary is not configured'));
  sdk ??= import('cloudinary').then(({ v2 }) => {
    v2.config({ cloud_name: c.cloudName, api_key: c.apiKey, api_secret: c.apiSecret, secure: true });
    return v2;
  });
  return sdk;
}

export const cloudinaryEnabled = () => config.cloudinary !== null;

const kind = (bucket: Bucket) =>
  bucket === 'documents' ? ({ resource_type: 'raw', type: 'authenticated' } as const) : ({ resource_type: 'image', type: 'upload' } as const);

/** Cloudinary id for a storage path. Raw ids keep the extension; image ids don't (Cloudinary adds the format). */
export function publicId(bucket: Bucket, path: string, folder = config.cloudinary?.folder ?? 'ksr'): string {
  return bucket === 'documents' ? `${folder}/documents/${path}` : `${folder}/car-photos/${path.replace(/\.webp$/, '')}`;
}

/** Public CDN address of a car photo. */
export function carPhotoCdnUrl(path: string): string {
  const c = config.cloudinary!;
  return `https://res.cloudinary.com/${c.cloudName}/image/upload/${publicId('car-photos', path)}.webp`;
}

const httpCode = (err: unknown) => (err as { error?: { http_code?: number }; http_code?: number })?.error?.http_code ?? (err as { http_code?: number })?.http_code;
const message = (err: unknown) => (err as { error?: { message?: string } })?.error?.message ?? (err as Error)?.message ?? 'unknown error';

/** Upload a file; 'exists' when something is already stored at that path (never overwritten). */
export async function cloudSave(bucket: Bucket, path: string, bytes: Uint8Array): Promise<'saved' | 'exists'> {
  const v2 = await client();
  const result = await new Promise<{ existing?: boolean }>((resolve, reject) => {
    const upload = v2.uploader.upload_stream(
      { public_id: publicId(bucket, path), ...kind(bucket), overwrite: false, unique_filename: false, use_filename: false },
      (err, res) => (err ? reject(new Error(`Cloudinary upload failed: ${message(err)}`, { cause: err })) : resolve((res ?? {}) as { existing?: boolean })),
    );
    upload.end(Buffer.from(bytes));
  });
  return result.existing ? 'exists' : 'saved';
}

/** Fetch a stored file (documents are at most 10 MB), or null when it isn't there. */
export async function cloudOpen(bucket: Bucket, path: string): Promise<{ size: number; stream: ReadableStream<Uint8Array> } | null> {
  const v2 = await client();
  const url =
    bucket === 'documents'
      ? v2.utils.private_download_url(publicId(bucket, path), '', { ...kind(bucket), expires_at: Math.floor(Date.now() / 1000) + 60 })
      : carPhotoCdnUrl(path);
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Cloudinary download failed (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { size: bytes.length, stream: new Blob([bytes]).stream() };
}

export async function cloudExists(bucket: Bucket, path: string): Promise<boolean> {
  const v2 = await client();
  try {
    await v2.api.resource(publicId(bucket, path), kind(bucket));
    return true;
  } catch (err) {
    if (httpCode(err) === 404) return false;
    throw new Error(`Cloudinary lookup failed: ${message(err)}`, { cause: err });
  }
}

/** Delete files (missing ones count as deleted). The CDN copy of a photo is invalidated too. */
export async function cloudRemove(bucket: Bucket, paths: readonly string[]): Promise<void> {
  const v2 = await client();
  for (const path of paths) {
    const r = (await v2.uploader.destroy(publicId(bucket, path), { ...kind(bucket), invalidate: true })) as { result?: string };
    if (r.result !== 'ok' && r.result !== 'not found') throw new Error(`Cloudinary delete failed: ${r.result ?? 'unknown'}`);
  }
}
