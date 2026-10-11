// Row writes with the bookkeeping the Postgres triggers used to do: ids and timestamps,
// actor columns, the audit trail with before/after of changed fields (AUD-01/02), and the
// car price history (FLT-03). Business functions and the data API both write through here.
import type { Ctx } from '../access/context.ts';
import { writeAudit } from '../audit.ts';
import { ApiError } from '../errors.ts';
import { all, nowIso, one, uuid, type Row } from './connection.ts';
import { decodeRow, encodeValue, EncodeError, table } from './registry.ts';
import type { Sql } from '../access/scope.ts';

/** Tables whose row changes are written to the audit log automatically. */
export const AUDITED_TABLES = new Set([
  'cars',
  'car_photos',
  'maintenance_windows',
  'customers',
  'bookings',
  'booking_charges',
  'payments',
  'handover_records',
  'settings',
  'policy_versions',
  'user_roles',
  'staff_profiles',
  'document_types',
  'data_requests',
  'service_logs',
]);

/** Filled with the signed-in user when a write leaves them empty (like `default auth.uid()`). */
const ACTOR_COLUMNS_ON_INSERT = ['created_by', 'published_by', 'updated_by'];

export interface WriteOptions {
  /** false skips the automatic audit entry (retention purges write their own summary). */
  audit?: boolean;
}

function encodeRow(tableName: string, values: Row): { cols: string[]; params: ReturnType<typeof encodeValue>[] } {
  const info = table(tableName);
  const cols: string[] = [];
  const params: ReturnType<typeof encodeValue>[] = [];
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) continue;
    if (!info.writable.has(k)) throw new ApiError(`Unknown field "${k}".`, 'invalid', { status: 400 });
    try {
      params.push(encodeValue(info.columns.get(k), v, k));
    } catch (err) {
      if (err instanceof EncodeError) throw new ApiError(`Invalid value: ${err.message}.`, k, { status: 400 });
      throw err;
    }
    cols.push(k);
  }
  return { cols, params };
}

const pkOf = (tableName: string) => {
  const pk = table(tableName).pk;
  if (!pk) throw new Error(`Table ${tableName} has no primary key`);
  return pk;
};

function diff(before: Row, after: Row): { before: Row; after: Row } | null {
  const b: Row = {};
  const a: Row = {};
  for (const k of Object.keys(after)) {
    if (k === 'updated_at' || k === 'created_at') continue;
    if (JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)) {
      b[k] = before[k] ?? null;
      a[k] = after[k] ?? null;
    }
  }
  return Object.keys(a).length ? { before: b, after: a } : null;
}

// ------------------------------------------------------------------ hooks (ported triggers)
function afterWrite(ctx: Ctx, tableName: string, before: Row | null, after: Row | null): void {
  if (tableName === 'cars' && after) {
    // FLT-03: price history whenever a price is set or changes.
    if (!before || before.price_12h_paise !== after.price_12h_paise || before.price_24h_paise !== after.price_24h_paise) {
      insertRow(
        ctx,
        'car_price_history',
        { car_id: after.id, price_12h_paise: after.price_12h_paise, price_24h_paise: after.price_24h_paise, changed_by: ctx.userId },
        { audit: false },
      );
    }
  }
}

export function getRow<T = Row>(tableName: string, pkValue: unknown): T | undefined {
  return decodeRow<T>(tableName, one(`SELECT * FROM "${tableName}" WHERE "${pkOf(tableName)}" = ?`, pkValue as string));
}

export function insertRow<T = Row>(ctx: Ctx, tableName: string, values: Row, opts: WriteOptions = {}): T {
  const info = table(tableName);
  const row: Row = { ...values };
  const now = nowIso();
  if (info.pk === 'id' && (row.id === undefined || row.id === null) && info.columns.get('id') === 'text') row.id = uuid();
  if (info.columns.has('created_at') && row.created_at === undefined) row.created_at = now;
  if (info.columns.has('updated_at') && row.updated_at === undefined) row.updated_at = now;
  for (const c of ACTOR_COLUMNS_ON_INSERT) if (info.writable.has(c) && row[c] === undefined && ctx.userId) row[c] = ctx.userId;
  const { cols, params } = encodeRow(tableName, row);
  const inserted = decodeRow<Row>(
    tableName,
    one(`INSERT INTO "${tableName}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING *`, ...params),
  )!;
  if (opts.audit !== false && AUDITED_TABLES.has(tableName)) {
    writeAudit(ctx, `${tableName}.insert`, tableName, String(inserted[pkOf(tableName)]), null, inserted);
  }
  afterWrite(ctx, tableName, null, inserted);
  return inserted as T;
}

export function updateRow<T = Row>(ctx: Ctx, tableName: string, pkValue: unknown, patch: Row, opts: WriteOptions = {}): T | undefined {
  const info = table(tableName);
  const pk = pkOf(tableName);
  const before = getRow<Row>(tableName, pkValue);
  if (!before) return undefined;
  const values: Row = { ...patch };
  delete values[pk];
  if (info.columns.has('updated_at') && values.updated_at === undefined) values.updated_at = nowIso();
  if (info.writable.has('updated_by') && values.updated_by === undefined && ctx.userId) values.updated_by = ctx.userId;
  const { cols, params } = encodeRow(tableName, values);
  if (!cols.length) return before as T;
  const after = decodeRow<Row>(
    tableName,
    one(`UPDATE "${tableName}" SET ${cols.map((c) => `"${c}" = ?`).join(', ')} WHERE "${pk}" = ? RETURNING *`, ...params, pkValue as string),
  )!;
  const changed = diff(before, after);
  if (changed && opts.audit !== false && AUDITED_TABLES.has(tableName)) {
    writeAudit(ctx, `${tableName}.update`, tableName, String(pkValue), changed.before, changed.after);
  }
  if (changed) afterWrite(ctx, tableName, before, after);
  return after as T;
}

export function deleteRow<T = Row>(ctx: Ctx, tableName: string, pkValue: unknown, opts: WriteOptions = {}): T | undefined {
  const before = getRow<Row>(tableName, pkValue);
  if (!before) return undefined;
  one(`DELETE FROM "${tableName}" WHERE "${pkOf(tableName)}" = ? RETURNING 1`, pkValue as string);
  if (opts.audit !== false && AUDITED_TABLES.has(tableName)) {
    writeAudit(ctx, `${tableName}.delete`, tableName, String(pkValue), before, null);
  }
  return before as T;
}

/** Primary keys of rows matching a condition (table aliased as t). */
export function pksWhere(tableName: string, where: Sql): unknown[] {
  const pk = pkOf(tableName);
  return all<Row>(`SELECT t."${pk}" AS pk FROM "${tableName}" t WHERE ${where.sql}`, ...where.params).map((r) => r.pk);
}

export function updateWhere(ctx: Ctx, tableName: string, where: Sql, patch: Row, opts: WriteOptions = {}): Row[] {
  return pksWhere(tableName, where)
    .map((pk) => updateRow<Row>(ctx, tableName, pk, patch, opts))
    .filter((r): r is Row => Boolean(r));
}

export function deleteWhere(ctx: Ctx, tableName: string, where: Sql, opts: WriteOptions = {}): Row[] {
  return pksWhere(tableName, where)
    .map((pk) => deleteRow<Row>(ctx, tableName, pk, opts))
    .filter((r): r is Row => Boolean(r));
}
