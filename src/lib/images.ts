// Browser-side image preparation. Re-encoding through a canvas strips EXIF data, including
// GPS location (Section 10.5), and lets us resize large phone photos before upload (DOC-03).
import { MAX_IMAGE_DIMENSION, MAX_UPLOAD_BYTES, sniffMime } from '@shared/documents.ts';
import { AppError } from './errors';

type Drawable = ImageBitmap | HTMLImageElement;

export async function readHead(file: Blob, bytes = 32): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, bytes).arrayBuffer());
}

export async function isHeic(file: File | Blob): Promise<boolean> {
  if (/image\/hei[cf]/i.test(file.type)) return true;
  if (file instanceof File && /\.(heic|heif)$/i.test(file.name)) return true;
  return (await sniffMime(await readHead(file))) === 'image/heic';
}

/** HEIC/HEIF (iPhone photos) to JPG, loading the converter only when needed. */
export async function heicToJpeg(file: Blob): Promise<Blob> {
  const { default: heic2any } = await import('heic2any');
  const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
  return Array.isArray(out) ? out[0] : out;
}

export async function loadImage(file: Blob): Promise<Drawable> {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // fall through to <img>
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const sizeOf = (img: Drawable) => ({ width: img.width, height: img.height });

export function fitWithin(width: number, height: number, max: number) {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export async function encodeCanvas(
  img: Drawable | HTMLCanvasElement,
  width: number,
  height: number,
  type: 'image/jpeg' | 'image/png' | 'image/webp',
  quality = 0.86,
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new AppError('This browser cannot process images.');
  if (type === 'image/jpeg') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  if (!blob) throw new AppError('Could not process this image. Try another photo.');
  // Safari may silently fall back to PNG when WebP encoding is unsupported.
  if (type === 'image/webp' && blob.type !== 'image/webp') {
    throw new AppError('This browser cannot create WebP images. Use Chrome, Edge or Firefox to upload car photos.');
  }
  return blob;
}

export interface PreparedFile {
  blob: Blob;
  name: string;
  mime: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';
  width?: number;
  height?: number;
}

const renameExt = (name: string, ext: string) => `${name.replace(/\.[^.]+$/, '') || 'document'}.${ext}`;

/**
 * Prepare a document for upload (DOC-03): HEIC → JPG, images over 2,500 px resized,
 * every image re-encoded (strips location metadata). PDFs are passed through.
 */
export async function prepareDocumentFile(file: File): Promise<PreparedFile> {
  let blob: Blob = file;
  let name = file.name || 'document';
  if (await isHeic(file)) {
    blob = await heicToJpeg(file);
    name = renameExt(name, 'jpg');
  }
  const kind = sniffMime(await readHead(blob));
  if (kind === 'application/pdf') {
    if (blob.size > MAX_UPLOAD_BYTES) throw new AppError('Files must be 10 MB or smaller.');
    return { blob, name, mime: 'application/pdf' };
  }
  if (!kind || kind === 'image/heic') {
    throw new AppError('Upload a JPG, PNG, WebP, HEIC or PDF file.');
  }
  const img = await loadImage(blob);
  const size = fitWithin(sizeOf(img).width, sizeOf(img).height, MAX_IMAGE_DIMENSION);
  const mime = kind === 'image/png' ? 'image/png' : kind === 'image/webp' ? 'image/webp' : 'image/jpeg';
  let out = await encodeCanvas(img, size.width, size.height, mime);
  if (out.size > MAX_UPLOAD_BYTES && mime !== 'image/jpeg') {
    out = await encodeCanvas(img, size.width, size.height, 'image/jpeg', 0.85);
    name = renameExt(name, 'jpg');
    return finish(out, name, 'image/jpeg', size);
  }
  return finish(out, name, mime, size);
}

function finish(blob: Blob, name: string, mime: PreparedFile['mime'], size: { width: number; height: number }): PreparedFile {
  if (blob.size > MAX_UPLOAD_BYTES) throw new AppError('This image is still over 10 MB after resizing. Try a smaller photo.');
  return { blob, name, mime, width: size.width, height: size.height };
}

export interface CarPhotoVariants {
  full: Blob;
  medium: Blob;
  small: Blob;
  width: number;
  height: number;
}

/** Car photos (FLT-05): resized and converted to WebP at 1600, 800 and 400 px wide. */
export async function prepareCarPhoto(file: File): Promise<CarPhotoVariants> {
  if (file.size > MAX_UPLOAD_BYTES) throw new AppError('Photos must be 10 MB or smaller.');
  let blob: Blob = file;
  if (await isHeic(file)) blob = await heicToJpeg(file);
  const kind = sniffMime(await readHead(blob));
  if (!kind || kind === 'application/pdf' || kind === 'image/heic') throw new AppError('Upload a JPG, PNG, WebP or HEIC photo.');
  const img = await loadImage(blob);
  const full = fitWithin(img.width, img.height, 1600);
  const medium = fitWithin(img.width, img.height, 800);
  const small = fitWithin(img.width, img.height, 400);
  return {
    full: await encodeCanvas(img, full.width, full.height, 'image/webp', 0.82),
    medium: await encodeCanvas(img, medium.width, medium.height, 'image/webp', 0.8),
    small: await encodeCanvas(img, small.width, small.height, 'image/webp', 0.78),
    width: full.width,
    height: full.height,
  };
}
