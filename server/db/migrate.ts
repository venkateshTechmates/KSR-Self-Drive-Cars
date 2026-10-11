// Creates and upgrades the database. Schema versions are tracked with PRAGMA user_version;
// add new numbered steps to MIGRATIONS (never edit an applied one).
import { readFileSync } from 'node:fs';
import { getDb } from './connection.ts';
import { loadRegistry } from './registry.ts';

const UUID_SQL =
  "(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))))";
const NOW_SQL = "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";

const sqlFile = (name: string) =>
  readFileSync(new URL(`./${name}`, import.meta.url), 'utf8').replaceAll('{{UUID}}', UUID_SQL).replaceAll('{{NOW}}', NOW_SQL);

const MIGRATIONS: Array<{ version: number; name: string; sql: () => string }> = [
  { version: 1, name: 'schema', sql: () => sqlFile('schema.sql') },
  { version: 2, name: 'reference data', sql: () => sqlFile('seed.sql') },
];

export function migrate(): { from: number; to: number } {
  const db = getDb();
  const from = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  let version = from;
  for (const m of MIGRATIONS) {
    if (m.version <= version) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql());
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${m.version} (${m.name}) failed: ${(err as Error).message}`, { cause: err });
    }
    version = m.version;
  }
  loadRegistry();
  return { from, to: version };
}
