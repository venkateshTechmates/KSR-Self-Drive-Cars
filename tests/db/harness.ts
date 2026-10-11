// Runs the real migrations in PGlite (Postgres compiled to WASM) with small stand-ins for
// the Supabase pieces they rely on: the anon/authenticated/service_role roles, auth.users,
// auth.uid()/auth.jwt(), and the storage schema.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';

const SUPABASE_STUBS = /* sql */ `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role supabase_auth_admin nologin noinherit;

create schema auth;
create table auth.users (id uuid primary key, email text unique, created_at timestamptz default now());
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select auth.jwt() ->> 'role'
$$;
grant usage on schema auth to anon, authenticated, service_role, supabase_auth_admin;
grant select on auth.users to supabase_auth_admin;
grant execute on all functions in schema auth to anon, authenticated, service_role;

create schema storage;
create table storage.buckets (
  id text primary key, name text not null, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[]
);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
alter table storage.objects enable row level security;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

export const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');

export async function createDb(): Promise<PGlite> {
  const db = await PGlite.create({ extensions: { btree_gist } });
  await db.exec(SUPABASE_STUBS);
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await db.exec(sql);
    } catch (err) {
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
    }
  }
  return db;
}

export type Role = 'owner' | 'manager' | 'staff';

export interface TestUser {
  id: string;
  email: string;
  role: Role;
}

let userSeq = 0;

export async function addStaff(db: PGlite, role: Role, name: string = role): Promise<TestUser> {
  userSeq += 1;
  const id = `00000000-0000-4000-8000-${String(userSeq).padStart(12, '0')}`;
  const email = `${name}${userSeq}@ksr.test`;
  await db.query('insert into auth.users (id, email) values ($1, $2)', [id, email]);
  await db.query('insert into public.staff_profiles (user_id, full_name, email) values ($1, $2, $3)', [id, name, email]);
  await db.query('insert into public.user_roles (user_id, role) values ($1, $2)', [id, role]);
  return { id, email, role };
}

/** Run `fn` as a signed-in user, the way PostgREST would (role + JWT claims). */
export async function asUser<T>(db: PGlite, user: TestUser | null, fn: () => Promise<T>, aal = 'aal2'): Promise<T> {
  const claims = user ? { sub: user.id, role: 'authenticated', aal } : { role: 'anon' };
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
  await db.exec(`set role ${user ? 'authenticated' : 'anon'}`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '', false)`);
  }
}

/** Run as the service role (edge functions). */
export async function asService<T>(db: PGlite, fn: () => Promise<T>): Promise<T> {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: 'service_role' })]);
  await db.exec('set role service_role');
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '', false)`);
  }
}

export async function carId(db: PGlite, slug: string): Promise<string> {
  const r = await db.query<{ id: string }>('select id from public.cars where slug = $1', [slug]);
  if (!r.rows[0]) throw new Error(`No car ${slug}`);
  return r.rows[0].id;
}

/** Postgres error fields surfaced by PGlite. */
export function pgError(err: unknown): { message: string; detail?: string; hint?: string } {
  const e = err as { message: string; detail?: string; hint?: string };
  return { message: e.message, detail: e.detail, hint: e.hint };
}
