// Dev check: every column the front end names in PostgREST queries exists in the schema.
// Usage: node tests/db/columns-check.mjs   (run from the repo root)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';

const STUBS = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create role supabase_auth_admin nologin;
create schema auth; create table auth.users (id uuid primary key, email text);
create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create schema storage; create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
`;

const db = await PGlite.create({ extensions: { btree_gist } });
await db.exec(STUBS);
for (const f of readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort()) await db.exec(readFileSync(join('supabase/migrations', f), 'utf8'));
const cols = new Map();
for (const r of (await db.query(`select table_name, column_name from information_schema.columns where table_schema = 'public'`)).rows) {
  if (!cols.has(r.table_name)) cols.set(r.table_name, new Set());
  cols.get(r.table_name).add(r.column_name);
}
// FK relationships usable as embeds: alias:table(...) or table(...)
const tables = new Set(cols.keys());

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(f)) out.push(p);
  }
  return out;
}

/** Parse a PostgREST select string into [table, column] pairs to check. */
function selectColumns(table, sel, out) {
  let i = 0;
  const items = [];
  let depth = 0;
  let cur = '';
  for (; i < sel.length; i++) {
    const ch = sel[i];
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      items.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) items.push(cur.trim());
  for (const item of items) {
    if (item === '*' || !item) continue;
    const embed = /^(?:(\w+):)?(\w+)(?:!\w+)?\s*\(([\s\S]*)\)$/.exec(item);
    if (embed) {
      const target = embed[2];
      if (!tables.has(target)) out.push(`unknown embedded table ${target}`);
      else selectColumns(target, embed[3], out);
      continue;
    }
    const col = item.replace(/^\w+:/, '').replace(/::\w+$/, '').split('->')[0].trim();
    if (/^(count|sum|avg|min|max)\(/.test(col)) continue;
    if (!cols.get(table)?.has(col)) out.push(`${table}.${col}`);
  }
}

let problems = 0;
let checked = 0;
const BASE = [...BOOKING_SELECT()];
function BOOKING_SELECT() {
  const m = /BOOKING_SELECT\s*=\s*\n?\s*'([^']+)'/.exec(readFileSync('src/admin/hooks/bookings.ts', 'utf8'));
  return m ? [m[1]] : [];
}
for (const file of walk('src')) {
  const text = readFileSync(file, 'utf8');
  const fromRe = /\.from\(['"](\w+)['"]\)/g;
  let m;
  while ((m = fromRe.exec(text))) {
    const table = m[1];
    if (!cols.has(table)) {
      console.log(`UNKNOWN TABLE ${table} ${file}`);
      problems++;
      continue;
    }
    // The query chain: up to the next statement end or next .from(
    const rest = text.slice(m.index + m[0].length, m.index + m[0].length + 1500);
    const end = rest.search(/;\s*\n|\.from\(/);
    const chain = end >= 0 ? rest.slice(0, end) : rest;
    const line = text.slice(0, m.index).split('\n').length;
    const where = `${file}:${line}`;
    const out = [];
    const sel = /\.select\(\s*(['`])([^'`$]*)\1/.exec(chain);
    if (sel) selectColumns(table, sel[2], out);
    if (/\.select\(\s*BOOKING_SELECT/.test(chain)) for (const s of BASE) selectColumns(table, s, out);
    for (const f of chain.matchAll(/\.(eq|neq|gt|gte|lt|lte|like|ilike|is|in|order|contains|not|filter)\(\s*['"]([\w.]+)['"]/g)) {
      const col = f[2];
      if (col.includes('.')) {
        const [t, c] = col.split('.');
        if (tables.has(t) && !cols.get(t).has(c)) out.push(`${t}.${c}`);
      } else if (!cols.get(table).has(col)) out.push(`${table}.${col}`);
    }
    for (const o of chain.matchAll(/\.(update|insert|upsert)\(\s*\{([^{}]*)\}/g)) {
      for (const k of o[2].matchAll(/(?:^|[,{\s])(\w+)\s*:/g)) if (!cols.get(table).has(k[1])) out.push(`${table}.${k[1]} (write)`);
    }
    checked++;
    for (const o of [...new Set(out)]) {
      console.log(`${o}  at ${where}`);
      problems++;
    }
  }
}
console.log(`${checked} queries checked, ${problems} possible problems`);
process.exit(0);
