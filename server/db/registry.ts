// Column types per table, read from the declared types in schema.sql ("BOOLEAN",
// "JSON TEXT", "TIMESTAMP TEXT", "DATE TEXT"), used to decode rows for the API and to
// encode values (and filter values) consistently.
import type { SQLInputValue } from 'node:sqlite';
import { all, type Row } from './connection.ts';

export type ColType = 'text' | 'int' | 'real' | 'bool' | 'json' | 'timestamp' | 'date';

export interface TableInfo {
  name: string;
  columns: Map<string, ColType>;
  /** Writable columns (excludes generated columns). */
  writable: Set<string>;
  pk: string | null;
  isView: boolean;
}

const tables = new Map<string, TableInfo>();

/** Types for view columns that SQLite can't infer. */
const VIEW_OVERRIDES: Record<string, Record<string, ColType>> = {
  public_cars: { photos: 'json', price_12h_paise: 'int', price_24h_paise: 'int', seats: 'int', sort_order: 'int' },
  public_settings: { value: 'json' },
  public_policies: { version: 'int', published_at: 'timestamp' },
};

function typeOf(declared: string): ColType {
  const t = declared.toUpperCase();
  if (t.includes('JSON')) return 'json';
  if (t.includes('TIMESTAMP')) return 'timestamp';
  if (t.includes('DATE')) return 'date';
  if (t.includes('BOOL')) return 'bool';
  if (t.includes('INT')) return 'int';
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'real';
  return 'text';
}

export function loadRegistry(): void {
  tables.clear();
  const objects = all<{ name: string; type: string }>(
    `SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'`,
  );
  for (const o of objects) {
    const cols = all<{ name: string; type: string; pk: number; hidden: number }>(`PRAGMA table_xinfo("${o.name}")`);
    const info: TableInfo = { name: o.name, columns: new Map(), writable: new Set(), pk: null, isView: o.type === 'view' };
    for (const c of cols) {
      const override = VIEW_OVERRIDES[o.name]?.[c.name];
      info.columns.set(c.name, override ?? typeOf(c.type ?? ''));
      // hidden 2/3 = generated column
      if (c.hidden !== 2 && c.hidden !== 3 && !info.isView) info.writable.add(c.name);
      if (c.pk === 1) info.pk = c.name;
    }
    tables.set(o.name, info);
  }
}

export function table(name: string): TableInfo {
  const t = tables.get(name);
  if (!t) throw new Error(`Unknown table ${name}`);
  return t;
}

export const hasTable = (name: string) => tables.has(name);

export function decodeValue(type: ColType | undefined, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  switch (type) {
    case 'bool':
      return v === 1 || v === 1n || v === true || v === '1';
    case 'json':
      if (typeof v !== 'string') return v;
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    case 'int':
      return typeof v === 'bigint' ? Number(v) : v;
    default:
      return typeof v === 'bigint' ? Number(v) : v;
  }
}

export function decodeRow<T = Row>(tableName: string, row: Row | undefined): T | undefined {
  if (!row) return undefined;
  const info = tables.get(tableName);
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) out[k] = decodeValue(info?.columns.get(k), v);
  return out as T;
}

export const decodeRows = <T = Row>(tableName: string, rows: Row[]): T[] => rows.map((r) => decodeRow<T>(tableName, r)!);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class EncodeError extends Error {}

/** Normalise a value for a column: booleans 0/1, JSON text, ISO timestamps, YYYY-MM-DD dates. */
export function encodeValue(type: ColType | undefined, v: unknown, column = ''): SQLInputValue {
  if (v === undefined || v === null) return null;
  switch (type) {
    case 'bool':
      if (typeof v === 'boolean') return v ? 1 : 0;
      if (v === 'true' || v === 1 || v === '1') return 1;
      if (v === 'false' || v === 0 || v === '0') return 0;
      throw new EncodeError(`${column} must be true or false`);
    case 'json':
      return JSON.stringify(v);
    case 'timestamp': {
      const d = v instanceof Date ? v : new Date(String(v));
      if (Number.isNaN(d.getTime())) throw new EncodeError(`${column} must be a date and time`);
      return d.toISOString();
    }
    case 'date': {
      const s = String(v).slice(0, 10);
      if (!DATE_RE.test(s)) throw new EncodeError(`${column} must be a date (YYYY-MM-DD)`);
      return s;
    }
    case 'int':
      if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
      if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v);
      if (typeof v === 'boolean') return v ? 1 : 0;
      throw new EncodeError(`${column} must be a whole number`);
    case 'real':
      if (typeof v === 'number') return v;
      if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
      throw new EncodeError(`${column} must be a number`);
    default:
      if (typeof v === 'object') return JSON.stringify(v);
      return typeof v === 'boolean' ? (v ? 'true' : 'false') : (v as SQLInputValue);
  }
}
