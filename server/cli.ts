// Admin commands. Run on the server (e.g. `fly ssh console`, Render shell, `railway run`):
//   npm run create-owner -- --email owner@example.com --name "Owner name" [--password "…"]
//     Without --password, prints a one-time link to choose a password (valid 7 days).
//   npm run backup       Writes a copy of the database to DATA_DIR/backups now.
//   npm run seed-demo -- --password "…" [--force]
//     Adds demo data (a Manager, a Staff member, customers and bookings in every state) to
//     try the admin. For a local or test database only, never a live one.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createAuthToken, passwordLink } from './auth/tokens.ts';
import { createOwner, openAndMigrate } from './boot.ts';
import { config } from './config.ts';
import { getDb, tx } from './db/connection.ts';
import { hasBookings, seedDemoData } from './demo.ts';

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: { email: { type: 'string' }, name: { type: 'string' }, password: { type: 'string' }, force: { type: 'boolean' } },
  allowPositionals: true,
});

openAndMigrate();

if (command === 'create-owner') {
  if (!values.email) {
    console.error('Usage: npm run create-owner -- --email owner@example.com --name "Owner name" [--password "…"]');
    process.exit(1);
  }
  try {
    const id = await createOwner(values.email, values.name ?? 'Owner', values.password ?? null);
    if (values.password) console.info(`Owner created. Sign in at ${config.siteUrl}/admin/login`);
    else {
      const token = tx(() => createAuthToken(id, 'invite'));
      console.info(`Owner created. Open this link to choose a password (valid 7 days):\n${passwordLink(token, 'invite')}`);
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
} else if (command === 'backup') {
  mkdirSync(config.backupsDir, { recursive: true });
  const file = join(config.backupsDir, `ksr-manual-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  getDb().exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  console.info(`Backup written to ${file}`);
} else if (command === 'seed-demo') {
  if (config.production && !values.force) {
    console.error('Refusing to add demo data in production. Use a local database.');
    process.exit(1);
  }
  if (hasBookings() && !values.force) {
    console.error('This database already has bookings. Add --force to add demo data anyway.');
    process.exit(1);
  }
  if (!values.password) {
    console.error('Usage: npm run seed-demo -- --password "a password for the demo Manager and Staff" [--force]');
    process.exit(1);
  }
  try {
    const demo = await seedDemoData({ password: values.password });
    console.info(`Demo data added. Sign in at ${config.siteUrl}/admin/login with the password you chose:`);
    console.info(`  Manager: ${demo.manager.email} (sets up two-step verification on first sign-in)`);
    console.info(`  Staff:   ${demo.staff.email}`);
    for (const [scenario, b] of Object.entries(demo.bookings)) console.info(`  ${b.code}  ${scenario}`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
} else {
  console.error('Commands: create-owner, backup, seed-demo');
  process.exit(1);
}
