// The e2e server: the built app (npm run build) in production mode on a fresh database with
// demo data. Started by Playwright (playwright.config.ts → webServer).
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { E2E } from './env.ts';

const dataDir = resolve(E2E.dataDir);
rmSync(dataDir, { recursive: true, force: true });
rmSync(resolve(E2E.authDir), { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

// Server modules read their configuration on import, so set it first. Empty SMTP settings
// keep a local .env from sending real email during tests.
Object.assign(process.env, {
  NODE_ENV: 'production',
  DATA_DIR: dataDir,
  PORT: String(E2E.port),
  SITE_URL: E2E.baseURL,
  APP_SECRET: E2E.appSecret,
  RATE_LIMIT_SALT: 'e2e-salt',
  RUN_JOBS: 'false',
  OWNER_EMAIL: E2E.owner.email,
  OWNER_PASSWORD: E2E.password,
  OWNER_NAME: E2E.owner.name,
  SMTP_HOST: '',
  SMTP_USER: '',
  SMTP_PASS: '',
  // Files stay on the test disk, never in a real Cloudinary account from a local .env.
  CLOUDINARY_URL: '',
  CLOUDINARY_CLOUD_NAME: '',
  CLOUDINARY_API_KEY: '',
  CLOUDINARY_API_SECRET: '',
});

const { openAndMigrate, bootstrapOwnerFromEnv } = await import('../server/boot.ts');
const { seedDemoData } = await import('../server/demo.ts');

openAndMigrate();
await bootstrapOwnerFromEnv();
const demo = await seedDemoData({ password: E2E.password, managerTotpSecret: E2E.managerTotpSecret });
writeFileSync(join(dataDir, 'demo.json'), JSON.stringify(demo, null, 2));
console.info(`[e2e] demo data ready: ${Object.keys(demo.bookings).length} bookings`);

await import('../server/index.ts');
