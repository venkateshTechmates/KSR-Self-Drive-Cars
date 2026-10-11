// Writes public/sitemap.xml and public/robots.txt (WEB-04) before each build.
// Car pages are included when VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY are set.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

function loadEnv() {
  const env = { ...process.env };
  for (const file of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

const env = loadEnv();
const site = (env.VITE_SITE_URL || 'https://ksr-self-drive-cars.lovable.app').replace(/\/$/, '');
const paths = ['/', '/privacy', '/terms', '/cancellation'];

const url = env.VITE_SUPABASE_URL;
const key = env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY;
if (url && key) {
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/public_cars?select=slug&order=sort_order`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (res.ok) for (const { slug } of await res.json()) paths.push(`/cars/${slug}`);
    else console.warn(`sitemap: could not load cars (${res.status}); writing base pages only`);
  } catch (err) {
    console.warn(`sitemap: could not load cars (${err.message}); writing base pages only`);
  }
}

const today = new Date().toISOString().slice(0, 10);
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths.map((p) => `  <url><loc>${site}${p}</loc><lastmod>${today}</lastmod></url>`).join('\n')}
</urlset>
`;
writeFileSync('public/sitemap.xml', xml);
writeFileSync(
  'public/robots.txt',
  `User-agent: *
Allow: /
Disallow: /admin
Disallow: /upload/
Disallow: /booking-status

Sitemap: ${site}/sitemap.xml
`,
);
console.log(`sitemap: ${paths.length} URLs for ${site}`);
