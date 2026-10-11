// Server test harness: a fresh in-memory SQLite database with the real schema and seed.
import { userCtx, systemCtx, anonCtx, type Ctx } from '../../server/access/context.ts';
import { openDatabase, setDb, one, run, uuid } from '../../server/db/connection.ts';
import { migrate } from '../../server/db/migrate.ts';
import type { AppRole } from '../../shared/constants.ts';

export function createTestDb(): void {
  setDb(openDatabase(':memory:'));
  migrate();
}

export interface TestUser {
  id: string;
  email: string;
  role: AppRole;
  /** Signed in with two-step done (aal2). */
  ctx: () => Ctx;
  /** Signed in without two-step (aal1). */
  ctxAal1: () => Ctx;
}

let seq = 0;

export function addStaff(role: AppRole, name: string = role): TestUser {
  seq += 1;
  const id = uuid();
  const email = `${name}${seq}@ksr.test`;
  run('INSERT INTO users (id, email) VALUES (?, ?)', id, email);
  run('INSERT INTO staff_profiles (user_id, full_name, email) VALUES (?, ?, ?)', id, name, email);
  run('INSERT INTO user_roles (user_id, role) VALUES (?, ?)', id, role);
  const make = (aal: 'aal1' | 'aal2') => () => userCtx({ userId: id, email, sessionId: null, aal, ip: '203.0.113.9', ua: 'vitest' });
  return { id, email, role, ctx: make('aal2'), ctxAal1: make('aal1') };
}

export const system = () => systemCtx();
export const visitor = () => anonCtx('203.0.113.50', 'vitest');

export const carId = (slug: string): string => {
  const row = one<{ id: string }>('SELECT id FROM cars WHERE slug = ?', slug);
  if (!row) throw new Error(`No car ${slug}`);
  return row.id;
};
