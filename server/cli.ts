// Admin commands. Run on the server (e.g. `fly ssh console`, Render shell, `railway run`):
//   npm run create-owner -- --email owner@example.com --name "Owner name" [--password "…"]
//     Without --password, prints a one-time link to choose a password (valid 7 days).
//   npm run backup       Writes a copy of the database to DATA_DIR/backups now.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createAuthToken, passwordLink } from './auth/tokens.ts';
import { createOwner, openAndMigrate } from './boot.ts';
import { config } from './config.ts';
import { getDb, tx } from './db/connection.ts';

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: { email: { type: 'string' }, name: { type: 'string' }, password: { type: 'string' } },
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
} else {
  console.error('Commands: create-owner, backup');
  process.exit(1);
}
