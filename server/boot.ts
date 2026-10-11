// Opening the database and first-run setup, shared by the server and the CLI.
import { userCtx } from './access/context.ts';
import { writeAudit } from './audit.ts';
import { hashPassword, passwordProblem } from './auth/crypto.ts';
import { config } from './config.ts';
import { nowIso, one, openDatabase, run, setDb, tx, uuid } from './db/connection.ts';
import { migrate } from './db/migrate.ts';

export function openAndMigrate(file = config.dbFile): void {
  setDb(openDatabase(file));
  const { from, to } = migrate();
  if (from !== to) console.info(`[db] migrated ${file} from version ${from} to ${to}`);
}

export const hasOwner = () => Boolean(one(`SELECT 1 FROM user_roles WHERE role = 'owner'`));

/**
 * Create the first Owner (ADM-02: no public sign-up). With a password they can sign in
 * straight away; without one, use `npm run invite-owner` to get a set-password link.
 */
export async function createOwner(email: string, name: string, password: string | null): Promise<string> {
  if (hasOwner()) throw new Error('An Owner already exists. Add more staff from /admin/staff.');
  const clean = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(clean)) throw new Error('Enter a valid email address.');
  if (password) {
    const problem = passwordProblem(password);
    if (problem) throw new Error(`OWNER_PASSWORD: ${problem}`);
  }
  const hash = password ? await hashPassword(password) : null;
  return tx(() => {
    const existing = one<{ id: string }>('SELECT id FROM users WHERE email = ? COLLATE NOCASE', clean);
    const id = existing?.id ?? uuid();
    const now = nowIso();
    if (existing) run('UPDATE users SET password_hash = coalesce(?, password_hash), banned = 0, updated_at = ? WHERE id = ?', hash, now, id);
    else run('INSERT INTO users (id, email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', id, clean, hash, now, now);
    run(
      `INSERT INTO staff_profiles (user_id, full_name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET active = 1, full_name = excluded.full_name`,
      id,
      name.trim() || 'Owner',
      clean,
      now,
      now,
    );
    run(`INSERT INTO user_roles (id, user_id, role, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?) ON CONFLICT (user_id) DO UPDATE SET role = 'owner'`, uuid(), id, now, now);
    writeAudit(userCtx({ userId: id, email: clean, sessionId: null, aal: 'aal1', ip: null, ua: 'setup' }), 'staff.bootstrap_owner', 'users', id, null, { email: clean });
    return id;
  });
}

/** OWNER_EMAIL / OWNER_PASSWORD on first boot (handy on Fly.io, Render and Railway). */
export async function bootstrapOwnerFromEnv(): Promise<void> {
  const { email, password, name } = config.bootstrapOwner;
  if (!email || hasOwner()) return;
  if (!password) {
    console.warn('[setup] OWNER_EMAIL is set but OWNER_PASSWORD is not; skipping. Or run: npm run create-owner');
    return;
  }
  await createOwner(email, name, password);
  console.info(`[setup] Owner account created for ${email}. Sign in at ${config.siteUrl}/admin and set up two-step verification. You can now remove OWNER_PASSWORD.`);
}
