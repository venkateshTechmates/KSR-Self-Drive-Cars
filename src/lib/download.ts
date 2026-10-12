// Saving a file the user asked for: CSV exports, documents, ZIPs of vehicle papers, data
// exports. A browser downloads it. The Android app's web view can't download, so the app
// offers the share sheet instead (save to Files or Drive, or send it).
//
// The copy made for sharing stays in the app's private cache until the next share or the
// next app start, because the receiving app (Drive, for example) may read it a little later.
import { isNativeApp } from './native';

const SHARE_DIR = 'share';

export async function saveFile(file: Blob, filename: string): Promise<void> {
  if (isNativeApp()) return shareFromApp(file, filename);
  const url = URL.createObjectURL(file);
  clickDownload(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A file behind a link (for example a signed document link). */
export async function saveFromUrl(url: string, filename: string): Promise<void> {
  if (!isNativeApp()) return clickDownload(url, filename);
  const res = await fetch(url);
  if (!res.ok) throw new Error("Couldn't download the file. Try again.");
  return shareFromApp(await res.blob(), filename);
}

function clickDownload(href: string, filename: string): void {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** "KSR bookings (Oct).csv" → "KSR_bookings_Oct_.csv": safe on every file system. */
export const safeFileName = (name: string) => name.replace(/[^\w.-]+/g, '_').slice(0, 120) || 'file';

function toBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the file."));
    reader.readAsDataURL(file);
  });
}

async function shareFromApp(file: Blob, filename: string): Promise<void> {
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([import('@capacitor/filesystem'), import('@capacitor/share')]);
  await clearSharedFiles();
  const path = `${SHARE_DIR}/${safeFileName(filename)}`;
  const { uri } = await Filesystem.writeFile({ path, data: await toBase64(file), directory: Directory.Cache, recursive: true });
  try {
    await Share.share({ title: filename, files: [uri], dialogTitle: 'Save or send' });
  } catch (err) {
    // Closing the share sheet is not an error.
    if (!/cancel/i.test((err as Error)?.message ?? '')) throw err;
  }
}

/** Remove files kept for an earlier share (private documents shouldn't linger). */
export async function clearSharedFiles(): Promise<void> {
  if (!isNativeApp()) return;
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  await Filesystem.rmdir({ path: SHARE_DIR, directory: Directory.Cache, recursive: true }).catch(() => undefined);
}
