// Environment / secrets. SUPABASE_* are provided by Supabase; the rest are function secrets
// (see supabase/functions/.env.example).

export function env(name: string): string | undefined {
  const v = Deno.env.get(name);
  return v === undefined || v.trim() === '' ? undefined : v.trim();
}

export function requireEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

/** Public origin of the site without a trailing slash, e.g. https://ksr-self-drive-cars.lovable.app. */
export function siteUrl(req?: Request): string {
  const configured = env('SITE_URL');
  if (configured) return configured.replace(/\/+$/, '');
  const origin = req?.headers.get('origin');
  return origin ? origin.replace(/\/+$/, '') : '';
}
