// SQLite connection (node:sqlite) and small query helpers. One process owns the database
// file; writes are serialised by SQLite, and tx() uses BEGIN IMMEDIATE so a booking check
// and its insert can't interleave with another request.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export type Db = DatabaseSync;
export type Row = Record<string, unknown>;
export type Param = SQLInputValue | boolean | undefined | Date;

let current: Db | null = null;
let depth = 0;
const statements = new Map<string, ReturnType<Db['prepare']>>();

export function openDatabase(file: string): Db {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  return db;
}

export function setDb(db: Db): void {
  current = db;
  statements.clear();
  depth = 0;
}

export function getDb(): Db {
  if (!current) throw new Error('Database is not open');
  return current;
}

export const bindValue = (v: Param): SQLInputValue =>
  v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v instanceof Date ? v.toISOString() : v;

function statement(sql: string) {
  let s = statements.get(sql);
  if (!s) {
    s = getDb().prepare(sql);
    if (statements.size > 500) statements.clear();
    statements.set(sql, s);
  }
  return s;
}

/** All rows (raw: booleans are 0/1, JSON is text; use registry.decodeRow for typed rows). */
export function all<T = Row>(sql: string, ...params: Param[]): T[] {
  return statement(sql).all(...params.map(bindValue)) as T[];
}

export function one<T = Row>(sql: string, ...params: Param[]): T | undefined {
  return statement(sql).get(...params.map(bindValue)) as T | undefined;
}

export function run(sql: string, ...params: Param[]): { changes: number } {
  const r = statement(sql).run(...params.map(bindValue));
  return { changes: Number(r.changes) };
}

/** First column of the first row. */
export function scalar<T = unknown>(sql: string, ...params: Param[]): T | undefined {
  const row = one<Row>(sql, ...params);
  return row ? (Object.values(row)[0] as T) : undefined;
}

/**
 * Run fn in a write transaction (BEGIN IMMEDIATE). Nested calls use savepoints.
 * fn must be synchronous: node:sqlite is synchronous, and awaiting inside would let other
 * requests run between the check and the write.
 */
export function tx<T>(fn: () => T): T {
  const db = getDb();
  if (depth > 0) {
    const name = `sp_${depth}`;
    db.exec(`SAVEPOINT ${name}`);
    depth += 1;
    try {
      const result = fn();
      db.exec(`RELEASE ${name}`);
      return result;
    } catch (err) {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
      throw err;
    } finally {
      depth -= 1;
    }
  }
  db.exec('BEGIN IMMEDIATE');
  depth = 1;
  try {
    const result = fn();
    if (result instanceof Promise) throw new Error('tx() callbacks must be synchronous');
    db.exec('COMMIT');
    return result;
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  } finally {
    depth = 0;
  }
}

export const nowIso = (): string => new Date().toISOString();

export const uuid = (): string => crypto.randomUUID();
