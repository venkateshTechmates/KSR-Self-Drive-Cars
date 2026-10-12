// Files on disk: signed private document links (/api/files/:token), car photo uploads
// (/api/storage/car-photos/...) and public car photos (/media/car-photos/...).
//
//   GET  /api/files/:token                 a document, through a 5-minute signed link (DOC-05)
//   PUT  /api/storage/car-photos/<path>    Owner/Manager; raw WebP body; never overwrites (409)
//   POST /api/storage/car-photos/remove    Owner/Manager; JSON { paths: string[] }
//   GET  /media/car-photos/<path>          public, cached for a year (files are immutable)
import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppRole } from '../../shared/constants.ts';
import { MAX_UPLOAD_BYTES, SIGNED_URL_SECONDS, sniffMime } from '../../shared/documents.ts';
import type { Ctx } from '../access/context.ts';
import { signPayload, verifyPayload } from '../auth/crypto.ts';
import { one } from '../db/connection.ts';
import { ApiError } from '../errors.ts';
import { requireUser, type AppEnv } from '../http.ts';
import { carPhotoCdnUrl, cloudinaryEnabled } from '../cloudinary.ts';
import { FileExistsError, isValidStoragePath, localFileExists, openFile, removeFiles, saveFile } from '../storage.ts';

export const fileRoutes = new Hono<AppEnv>();

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID}$`, 'i');
/** cars/<car_id>/<photo_id>.webp plus the -800 / -400 variants beside it (6.8.3, WEB-05). */
const CAR_PHOTO_RE = new RegExp(`^cars/(${UUID})/${UUID}(?:-800|-400)?\\.webp$`, 'i');
const MAX_REMOVE = 100;

const apiError = (status: number, message: string, code: string, hint?: unknown) => new ApiError(message, code, { status, hint });

/**
 * Require an effective admin role (two-step verification done where required, ADM-03).
 * Returns the role. Pass `roles` to restrict further.
 */
export function requireRole(ctx: Ctx, roles?: readonly AppRole[]): AppRole {
  const role = ctx.role;
  if (!role) {
    // An active staff account whose role needs two-step verification that isn't done yet.
    if (ctx.roleRaw) throw apiError(403, 'Complete two-step verification to continue.', 'mfa_required');
    throw apiError(403, 'Not allowed.', 'forbidden');
  }
  if (roles && !roles.includes(role)) throw apiError(403, 'Not allowed.', 'forbidden');
  return role;
}

/** Middleware: signed in with one of these roles (any admin role when omitted). */
export const requireRoles =
  (roles?: readonly AppRole[]): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    requireRole(requireUser(c), roles);
    await next();
  };

/** Reject bodies over `maxSize` bytes before (or while) reading them. */
export const limitBody = (maxSize: number, message = 'The upload is too large. Each file can be up to 10 MB.') =>
  bodyLimit({
    maxSize,
    onError: () => {
      throw apiError(413, message, 'too_large');
    },
  });

// ------------------------------------------------------------------ signed document links

interface FileLink {
  /** document id */
  d: string;
  /** expiry, epoch seconds */
  e: number;
  /** 1 = download (attachment), 0 = view inline */
  dl: 0 | 1;
}

/** A signed, short-lived link to a document's file (relative URL). */
export function signDocumentLink(documentId: string, download: boolean, nowMs = Date.now()): { url: string; expiresAt: string } {
  const e = Math.floor(nowMs / 1000) + SIGNED_URL_SECONDS;
  const payload: FileLink = { d: documentId, e, dl: download ? 1 : 0 };
  return { url: `/api/files/${signPayload(payload)}`, expiresAt: new Date(e * 1000).toISOString() };
}

/** Content-Disposition with an ASCII fallback and the UTF-8 name (RFC 6266 / RFC 5987). */
export function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  const fallback = [...filename].map((ch) => (/^[\x20-\x7e]$/.test(ch) && !/["\\;%]/.test(ch) ? ch : '_')).join('') || 'document';
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

fileRoutes.get('/api/files/:token', async (c) => {
  const link = verifyPayload<Partial<FileLink>>(c.req.param('token'));
  if (!link || typeof link.d !== 'string' || !UUID_RE.test(link.d) || typeof link.e !== 'number' || (link.dl !== 0 && link.dl !== 1)) {
    throw apiError(403, 'This link is not valid. Open the document again from the app.', 'invalid_link');
  }
  if (link.e * 1000 <= Date.now()) {
    throw apiError(410, 'This link has expired. Open the document again from the app.', 'expired');
  }
  // The document may have been erased since the link was issued.
  const doc = one<{ storage_path: string; original_filename: string; mime_type: string }>(
    'SELECT storage_path, original_filename, mime_type FROM documents WHERE id = ?',
    link.d,
  );
  if (!doc) throw apiError(404, 'Document not found.', 'not_found');
  const file = isValidStoragePath(doc.storage_path) ? await openFile('documents', doc.storage_path) : null;
  if (!file) throw apiError(404, 'The file for this document is missing.', 'file_missing');

  return c.body(file.stream, 200, {
    'Content-Type': doc.mime_type,
    'Content-Length': String(file.size),
    'Content-Disposition': contentDisposition(link.dl === 1 ? 'attachment' : 'inline', doc.original_filename || 'document'),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    // The admin's PDF viewer shows the file in an iframe on the same site.
    'Content-Security-Policy': "frame-ancestors 'self'",
    'Referrer-Policy': 'no-referrer',
  });
});

// ------------------------------------------------------------------ car photos (public store)

const ownerOrManager = requireRoles(['owner', 'manager']);
const PUT_PREFIX = '/api/storage/car-photos/';
const MEDIA_PREFIX = '/media/car-photos/';

fileRoutes.put('/api/storage/car-photos/*', ownerOrManager, limitBody(MAX_UPLOAD_BYTES, 'This photo is larger than 10 MB.'), async (c) => {
  const path = c.req.path.slice(PUT_PREFIX.length);
  const match = CAR_PHOTO_RE.exec(path);
  if (!match || !isValidStoragePath(path)) throw apiError(400, 'Invalid photo path.', 'invalid_path');
  const type = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'image/webp') throw apiError(415, 'Upload the photo as a WebP image.', 'unsupported_type');

  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.length === 0) throw apiError(400, 'This file is empty. Choose another file.', 'empty_file');
  if (bytes.length > MAX_UPLOAD_BYTES) throw apiError(413, 'This photo is larger than 10 MB.', 'too_large');
  // Checked by content, not by the declared type (10.5).
  if (sniffMime(bytes.subarray(0, 64)) !== 'image/webp') throw apiError(415, 'This file is not a WebP image.', 'unsupported_type');
  if (!one('SELECT 1 FROM cars WHERE id = ?', match[1].toLowerCase())) throw apiError(404, 'Car not found.', 'not_found');

  try {
    await saveFile('car-photos', path, bytes);
  } catch (err) {
    if (err instanceof FileExistsError) throw apiError(409, 'A photo already exists at this path.', 'exists');
    throw err;
  }
  return c.json({ path, fullPath: `car-photos/${path}` });
});

fileRoutes.post('/api/storage/car-photos/remove', ownerOrManager, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw apiError(400, 'Send the request as JSON.', 'bad_request');
  }
  const paths = (body as { paths?: unknown } | null)?.paths;
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_REMOVE) {
    throw apiError(400, `Send between 1 and ${MAX_REMOVE} photo paths.`, 'bad_request');
  }
  for (const p of paths) {
    if (typeof p !== 'string' || !CAR_PHOTO_RE.test(p) || !isValidStoragePath(p)) throw apiError(400, 'Invalid photo path.', 'invalid_path');
  }
  const removed = await removeFiles('car-photos', [...new Set(paths as string[])]);
  return c.json({ removed });
});

fileRoutes.get('/media/car-photos/*', async (c) => {
  const path = c.req.path.slice(MEDIA_PREFIX.length);
  if (!CAR_PHOTO_RE.test(path) || !isValidStoragePath(path)) return c.text('Not found', 404, { 'Cache-Control': 'no-store' });
  // Photos kept on the disk are served from here; the rest come from Cloudinary's CDN.
  const file = (await localFileExists('car-photos', path)) || !cloudinaryEnabled() ? await openFile('car-photos', path) : null;
  if (!file && cloudinaryEnabled()) {
    c.header('Cache-Control', 'public, max-age=86400');
    return c.redirect(carPhotoCdnUrl(path), 302);
  }
  if (!file) return c.text('Not found', 404, { 'Cache-Control': 'no-store' });
  return c.body(file.stream, 200, {
    'Content-Type': 'image/webp',
    'Content-Length': String(file.size),
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  });
});
