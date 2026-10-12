// Server address helpers (no React Native imports, so they can be unit tested with Node).

/** "192.168.0.6:3000/" → "http://192.168.0.6:3000"; null when it can't be a server address. */
export function normalizeServerUrl(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = `${/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/.test(s) ? 'http' : 'https'}://${s}`;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname || url.username || url.password) return null;
  return `${url.protocol}//${url.host}`;
}

/** Car photos are stored as {id}.webp with -400 and -800 versions beside them (src/lib/carPhotos.ts). */
export function carPhotoUrl(server: string, path: string, width: 400 | 800 = 800): string {
  return `${server}/media/car-photos/${path.replace(/\.webp$/, `-${width}.webp`)}`;
}

/** wa.me link for an E.164 number, with an optional message. */
export function whatsappUrl(e164: string, text?: string): string {
  const digits = e164.replace(/\D/g, '');
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}
