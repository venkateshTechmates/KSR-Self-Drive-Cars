// Server configuration from environment variables (see .env.example).
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function loadDotEnv(): void {
  for (const file of ['.env', '.env.local']) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
loadDotEnv();

const env = (k: string, fallback = ''): string => process.env[k]?.trim() || fallback;

const production = env('NODE_ENV') === 'production';
const dataDir = resolve(env('DATA_DIR', './data'));
mkdirSync(dataDir, { recursive: true });

/**
 * Secret for signing document links and encrypting TOTP secrets. Set APP_SECRET in
 * production; otherwise one is generated once and kept in the data directory.
 */
function appSecret(): string {
  const fromEnv = env('APP_SECRET');
  if (fromEnv) return fromEnv;
  const file = join(dataDir, '.app-secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const generated = randomBytes(32).toString('hex');
  writeFileSync(file, generated, { mode: 0o600 });
  return generated;
}

/**
 * Cloudinary file store (server/cloudinary.ts): CLOUDINARY_URL=cloudinary://<key>:<secret>@<cloud>,
 * or CLOUDINARY_CLOUD_NAME + CLOUDINARY_API_KEY + CLOUDINARY_API_SECRET. Without it, files stay
 * on the server's disk. Tests never use it.
 */
export function cloudinarySettings(get: (key: string) => string) {
  let cloudName = get('CLOUDINARY_CLOUD_NAME');
  let apiKey = get('CLOUDINARY_API_KEY');
  let apiSecret = get('CLOUDINARY_API_SECRET');
  const m = /^cloudinary:\/\/([^:]+):([^@]+)@([^/?#]+)/.exec(get('CLOUDINARY_URL'));
  if (m) [apiKey, apiSecret, cloudName] = [decodeURIComponent(m[1]), decodeURIComponent(m[2]), m[3]];
  if (!cloudName || !apiKey || !apiSecret) return null;
  return { cloudName, apiKey, apiSecret, folder: (get('CLOUDINARY_FOLDER') || 'ksr').replace(/^\/+|\/+$/g, '') || 'ksr' };
}

export const config = {
  production,
  port: Number(env('PORT', '3000')),
  dataDir,
  dbFile: join(dataDir, 'ksr.db'),
  filesDir: join(dataDir, 'files'),
  backupsDir: join(dataDir, 'backups'),
  /** Public origin of the site, without a trailing slash. Used in emails and links. */
  siteUrl: env('SITE_URL', 'http://localhost:8080').replace(/\/$/, ''),
  secret: appSecret(),
  rateLimitSalt: env('RATE_LIMIT_SALT') || appSecret(),
  /** Trust X-Forwarded-For (true behind Render/Railway/Fly proxies). */
  trustProxy: env('TRUST_PROXY', 'true') !== 'false',
  smtp: {
    host: env('SMTP_HOST'),
    port: Number(env('SMTP_PORT', '587')),
    secure: env('SMTP_SECURE') === 'true',
    user: env('SMTP_USER'),
    pass: env('SMTP_PASS'),
    from: env('SMTP_FROM', 'KSR Self Drive Cars <no-reply@localhost>'),
  },
  /** First-run bootstrap: creates the Owner if no Owner exists yet. */
  bootstrapOwner: {
    email: env('OWNER_EMAIL'),
    password: env('OWNER_PASSWORD'),
    name: env('OWNER_NAME', 'Owner'),
  },
  /** Static web app (vite build output). */
  distDir: resolve(env('DIST_DIR', './dist')),
  /** Scheduled jobs run in this process (disable for one-off CLI commands and tests). */
  runJobs: env('RUN_JOBS', 'true') !== 'false',
  /**
   * TWO_STEP=off switches two-step verification off for everyone, whatever Admin › Settings ›
   * Security says (for a trial period). Authenticator setups are kept; remove it to switch back on.
   */
  twoStep: !['off', 'false', '0', 'no'].includes(env('TWO_STEP', 'on').toLowerCase()),
  cloudinary: env('NODE_ENV') === 'test' ? null : cloudinarySettings((k) => env(k)),
};

export const smtpConfigured = () => Boolean(config.smtp.host);
