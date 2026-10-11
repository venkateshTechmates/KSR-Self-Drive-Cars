// Files on the persistent disk, under config.filesDir (6.8.3, 10.5):
//   documents/<storage_path>    private documents, served only through signed links
//   car-photos/<path>           public fleet photos (cars/<car_id>/<photo_id>[-800|-400].webp)
// Paths come from the database or from requests, so every one is validated strictly before
// it touches the file system: relative, no "." or ".." segments, only [A-Za-z0-9/_.-].
import { createReadStream } from 'node:fs';
import { mkdir, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { Readable } from 'node:stream';
import { config } from './config.ts';

export type Bucket = 'documents' | 'car-photos';

const BUCKETS: readonly Bucket[] = ['documents', 'car-photos'];
const PATH_RE = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const MAX_PATH_LENGTH = 400;

/** Thrown by saveFile when a file already exists at the path (files are never overwritten). */
export class FileExistsError extends Error {
  constructor() {
    super('A file already exists at this path');
    this.name = 'FileExistsError';
  }
}

/** True for a safe relative storage path. */
export function isValidStoragePath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH) return false;
  if (!PATH_RE.test(path)) return false;
  return path.split('/').every((segment) => segment !== '.' && segment !== '..');
}

const bucketRoot = (bucket: Bucket) => {
  if (!BUCKETS.includes(bucket)) throw new Error('Unknown storage bucket');
  return join(config.filesDir, bucket);
};

/** Absolute file name for a bucket path. Throws on an invalid path. */
export function storageFile(bucket: Bucket, path: string): string {
  if (!isValidStoragePath(path)) throw new Error('Invalid storage path');
  const root = bucketRoot(bucket);
  const full = join(root, ...path.split('/'));
  // Belt and braces: the validated path can't escape the bucket.
  if (!full.startsWith(root + sep)) throw new Error('Invalid storage path');
  return full;
}

const errCode = (err: unknown) => (err as NodeJS.ErrnoException | null)?.code;

/** Save a new file (creating folders). Never overwrites: throws FileExistsError instead. */
export async function saveFile(bucket: Bucket, path: string, bytes: Uint8Array): Promise<void> {
  const full = storageFile(bucket, path);
  for (let attempt = 0; ; attempt++) {
    await mkdir(dirname(full), { recursive: true });
    try {
      await writeFile(full, bytes, { flag: 'wx', mode: 0o600 });
      return;
    } catch (err) {
      if (errCode(err) === 'EEXIST') throw new FileExistsError();
      // A concurrent removeFiles() may have pruned the (then empty) folder; try once more.
      if (errCode(err) === 'ENOENT' && attempt === 0) continue;
      // Don't leave a partial file behind.
      await unlink(full).catch(() => undefined);
      throw err;
    }
  }
}

export interface StoredFile {
  size: number;
  /** Web stream of the file's bytes (closes the file when consumed or cancelled). */
  stream: ReadableStream<Uint8Array>;
}

/** Open a file for streaming, or null when it doesn't exist. */
export async function openFile(bucket: Bucket, path: string): Promise<StoredFile | null> {
  const full = storageFile(bucket, path);
  try {
    const info = await stat(full);
    if (!info.isFile()) return null;
    const stream = Readable.toWeb(createReadStream(full)) as unknown as ReadableStream<Uint8Array>;
    return { size: info.size, stream };
  } catch (err) {
    if (errCode(err) === 'ENOENT' || errCode(err) === 'ENOTDIR') return null;
    throw err;
  }
}

export async function fileExists(bucket: Bucket, path: string): Promise<boolean> {
  try {
    return (await stat(storageFile(bucket, path))).isFile();
  } catch (err) {
    if (errCode(err) === 'ENOENT' || errCode(err) === 'ENOTDIR') return false;
    throw err;
  }
}

/**
 * Remove files; missing ones count as removed. Empty folders left behind are pruned.
 * Returns the paths that were removed (or already gone). Throws on the first real failure.
 */
export async function removeFiles(bucket: Bucket, paths: readonly string[]): Promise<string[]> {
  const root = bucketRoot(bucket);
  const removed: string[] = [];
  for (const path of paths) {
    const full = storageFile(bucket, path);
    try {
      await unlink(full);
    } catch (err) {
      if (errCode(err) !== 'ENOENT' && errCode(err) !== 'ENOTDIR') throw err;
    }
    removed.push(path);
    // Prune now-empty parent folders up to (not including) the bucket root.
    for (let dir = dirname(full); dir.startsWith(root + sep); dir = dirname(dir)) {
      try {
        await rmdir(dir);
      } catch {
        break; // not empty (or already gone)
      }
    }
  }
  return removed;
}
