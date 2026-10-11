// The data API behind POST /api/query: executes the supabase-js style queries the web app
// builds (select with embedded relations, filters, or-trees, order, range, count, and plain
// inserts/updates/upserts/deletes), enforcing the table policies on every table touched —
// including embedded ones, so Staff get `customer: null` where they may not see the customer,
// exactly as Postgres row-level security behaved.
import type { Ctx } from '../access/context.ts';
import { and, FALSE, or, TRUE, type Sql } from '../access/scope.ts';
import { all, one, type Param, type Row } from '../db/connection.ts';
import { decodeRows, encodeValue, EncodeError, hasTable, table, type ColType, type TableInfo } from '../db/registry.ts';
import { deleteRow, insertRow, updateRow } from '../db/write.ts';
import { ApiError, forbidden } from '../errors.ts';
import { parseInList, parseOrList, parseSelect, unquote, type LogicNode, type SelectNode } from './parse.ts';
import { HIDDEN_COLUMNS, POLICIES } from './policies.ts';

export interface FilterSpec {
  /** eq | neq | gt | gte | lt | lte | like | ilike | is | in | ov | cs | not | or */
  op: string;
  column?: string;
  value?: unknown;
  /** For op 'not': the negated operator. */
  notOp?: string;
  /** For op 'or': the PostgREST logic string. */
  logic?: string;
}

export interface QueryRequest {
  table: string;
  action: 'select' | 'insert' | 'update' | 'upsert' | 'delete';
  /** Columns to return (select, or `.select()` after a write). Null after a write = return nothing. */
  select?: string | null;
  count?: 'exact' | null;
  head?: boolean;
  filters?: FilterSpec[];
  order?: Array<{ column: string; ascending?: boolean; nullsFirst?: boolean }>;
  limit?: number | null;
  offset?: number | null;
  values?: Row | Row[];
  onConflict?: string | null;
}

export interface QueryResult {
  data: unknown;
  count: number | null;
}

const invalid = (message: string): never => {
  throw new ApiError(message, 'invalid_query', { status: 400, pgCode: 'PGRST100' });
};

const q = (ident: string) => `"${ident}"`;

function policyFor(tableName: string) {
  const p = POLICIES[tableName];
  if (!p || !hasTable(tableName)) throw new ApiError(`Unknown table "${tableName}".`, 'not_found', { status: 404, pgCode: '42P01' });
  return p;
}

function readRule(ctx: Ctx, tableName: string, alias: string): Sql {
  if (ctx.system) return TRUE;
  const p = policyFor(tableName);
  return p.read ? p.read(ctx, alias) : FALSE;
}

function checkColumn(info: TableInfo, column: string): string {
  if (!info.columns.has(column)) invalid(`Column "${column}" does not exist on ${info.name}.`);
  return column;
}

// ------------------------------------------------------------------ filters

function coerce(type: ColType | undefined, v: unknown, column: string): Param {
  if (v === null) return null;
  try {
    return encodeValue(type, typeof v === 'string' && type === 'json' ? v : v, column) as Param;
  } catch (err) {
    if (err instanceof EncodeError) invalid(`Invalid filter value for ${column}.`);
    throw err;
  }
}

/** One comparison. `fromString` values come from an or-string and are still text. */
function condition(info: TableInfo, alias: string, column: string, op: string, raw: unknown, negate: boolean, fromString: boolean): Sql {
  checkColumn(info, column);
  const type = info.columns.get(column);
  const col = `${alias}.${q(column)}`;
  const text = (v: unknown) => (fromString ? unquote(String(v)) : v);
  let out: Sql;
  switch (op) {
    case 'eq':
    case 'neq':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const v = text(raw);
      if (v === null && op === 'eq') {
        out = { sql: `${col} IS NULL`, params: [] };
        break;
      }
      const sym = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
      out = { sql: `${col} ${sym} ?`, params: [coerce(type, type === 'bool' ? String(v) : v, column)] };
      break;
    }
    case 'like':
    case 'ilike': {
      const v = String(text(raw) ?? '').replaceAll('*', '%');
      out = { sql: `${col} LIKE ? ESCAPE '\\'`, params: [v] };
      break;
    }
    case 'is': {
      const v = String(text(raw)).toLowerCase();
      if (v === 'null') out = { sql: `${col} IS NULL`, params: [] };
      else if (v === 'true') out = { sql: `${col} = 1`, params: [] };
      else if (v === 'false') out = { sql: `${col} = 0`, params: [] };
      else return invalid(`Use is.null, is.true or is.false (${column}).`);
      break;
    }
    case 'in': {
      const list = fromString ? parseInList(String(raw)) : Array.isArray(raw) ? raw : invalid(`Expected a list for ${column}.`);
      if (!list.length) {
        out = FALSE;
        break;
      }
      out = { sql: `${col} IN (${list.map(() => '?').join(', ')})`, params: list.map((v) => coerce(type, v, column)) };
      break;
    }
    case 'ov':
    case 'cs': {
      // JSON array columns (e.g. bookings.flags): overlaps / contains.
      const list = fromString ? parseInList(String(raw).replace(/^\{/, '(').replace(/\}$/, ')')) : Array.isArray(raw) ? raw : invalid(`Expected a list for ${column}.`);
      if (!list.length) {
        out = op === 'ov' ? FALSE : TRUE;
        break;
      }
      const marks = list.map(() => '?').join(', ');
      out =
        op === 'ov'
          ? { sql: `EXISTS (SELECT 1 FROM json_each(${col}) WHERE value IN (${marks}))`, params: list.map(String) }
          : { sql: `(SELECT count(DISTINCT value) FROM json_each(${col}) WHERE value IN (${marks})) = ?`, params: [...list.map(String), new Set(list.map(String)).size] };
      break;
    }
    default:
      return invalid(`Unsupported filter "${op}".`);
  }
  return negate ? { sql: `NOT (${out.sql})`, params: out.params } : out;
}

function logic(info: TableInfo, alias: string, node: LogicNode): Sql {
  if (node.type === 'cond') return condition(info, alias, node.column, node.op, node.value, node.negate, true);
  const parts = node.items.map((n) => logic(info, alias, n));
  const combined = node.type === 'and' ? and(...parts) : or(...parts);
  return node.negate ? { sql: `NOT (${combined.sql})`, params: combined.params } : combined;
}

function filtersSql(info: TableInfo, alias: string, filters: FilterSpec[] = []): Sql {
  return and(
    ...filters.map((f) => {
      if (f.op === 'or') return logic(info, alias, parseOrList(String(f.logic ?? '')));
      if (!f.column) return invalid('Filter without a column.');
      if (f.column.includes('.')) return invalid('Filtering on embedded tables is not supported.');
      if (f.op === 'not') return condition(info, alias, f.column, String(f.notOp), f.value, true, typeof f.value === 'string' && f.notOp === 'in');
      return condition(info, alias, f.column, f.op, f.value, false, false);
    }),
  );
}

// ------------------------------------------------------------------ relations (from foreign keys)

interface Fk {
  from: string;
  table: string;
  to: string;
}
const fkCache = new Map<string, Fk[]>();

function foreignKeys(tableName: string): Fk[] {
  let fks = fkCache.get(tableName);
  if (!fks) {
    fks = all<{ table: string; from: string; to: string | null }>(`PRAGMA foreign_key_list(${q(tableName)})`).map((r) => ({
      from: r.from,
      table: r.table,
      to: r.to ?? table(r.table).pk ?? 'id',
    }));
    fkCache.set(tableName, fks);
  }
  return fks;
}

type Relation = { kind: 'one' | 'many'; parentCol: string; childCol: string };

function relation(parent: string, child: string, hint: string | null): Relation {
  const ones = foreignKeys(parent)
    .filter((f) => f.table === child && (!hint || f.from === hint))
    .map((f) => ({ kind: 'one' as const, parentCol: f.from, childCol: f.to }));
  const manys = foreignKeys(child)
    .filter((f) => f.table === parent && (!hint || f.from === hint))
    .map((f) => ({ kind: 'many' as const, parentCol: f.to, childCol: f.from }));
  const candidates = [...ones, ...manys];
  if (candidates.length === 1) return candidates[0];
  if (ones.length === 1) return ones[0];
  if (!candidates.length) return invalid(`No relationship between ${parent} and ${child}.`);
  return invalid(`More than one relationship between ${parent} and ${child}; add a hint like ${child}!column(...).`);
}

// ------------------------------------------------------------------ select

interface SelectOptions {
  where: Sql;
  order?: QueryRequest['order'];
  limit?: number | null;
  offset?: number | null;
}

function chunk<T>(list: T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function runSelect(ctx: Ctx, tableName: string, node: SelectNode, opts: SelectOptions): Row[] {
  const info = table(tableName);
  const hidden = new Set(HIDDEN_COLUMNS[tableName] ?? []);
  const outputs: Array<{ as: string; column: string }> = node.star
    ? [...info.columns.keys()].filter((c) => !hidden.has(c)).map((c) => ({ as: c, column: c }))
    : [];
  for (const c of node.columns) {
    checkColumn(info, c.column);
    if (hidden.has(c.column)) invalid(`Column "${c.column}" is not available.`);
    outputs.push(c);
  }
  const relations = node.embeds.map((e) => ({ embed: e, rel: relation(tableName, e.table, e.hint) }));
  const fetchCols = new Set([...outputs.map((o) => o.column), ...relations.map((r) => r.rel.parentCol)]);

  const where = and(readRule(ctx, tableName, 't'), opts.where);
  let sqlText = `SELECT ${[...fetchCols].map((c) => `t.${q(c)}`).join(', ') || '1 AS _'} FROM ${q(tableName)} t WHERE ${where.sql}`;
  const params: Param[] = [...where.params];
  if (opts.order?.length) {
    sqlText += ` ORDER BY ${opts.order
      .map((o) => {
        checkColumn(info, o.column);
        const asc = o.ascending !== false;
        // Postgres defaults: ASC → NULLS LAST, DESC → NULLS FIRST.
        const nullsFirst = o.nullsFirst ?? !asc;
        return `t.${q(o.column)} ${asc ? 'ASC' : 'DESC'} NULLS ${nullsFirst ? 'FIRST' : 'LAST'}`;
      })
      .join(', ')}`;
  }
  if (opts.limit !== undefined && opts.limit !== null) {
    sqlText += ' LIMIT ?';
    params.push(Math.max(0, Math.trunc(opts.limit)));
    if (opts.offset) {
      sqlText += ' OFFSET ?';
      params.push(Math.max(0, Math.trunc(opts.offset)));
    }
  } else if (opts.offset) {
    sqlText += ' LIMIT -1 OFFSET ?';
    params.push(Math.max(0, Math.trunc(opts.offset)));
  }
  const raw = decodeRows<Row>(tableName, all<Row>(sqlText, ...params));

  // Embedded relations, each read with its own table policy.
  for (const { embed, rel } of relations) {
    const keys = [...new Set(raw.map((r) => r[rel.parentCol]).filter((v) => v !== null && v !== undefined))] as Param[];
    const childNode: SelectNode = embed.select.star || embed.select.columns.some((c) => c.column === rel.childCol)
      ? embed.select
      : { ...embed.select, columns: [...embed.select.columns, { as: '__join', column: rel.childCol }] };
    const children: Row[] = [];
    for (const part of chunk(keys)) {
      children.push(
        ...runSelect(ctx, embed.table, childNode, {
          where: { sql: `t.${q(rel.childCol)} IN (${part.map(() => '?').join(', ')})`, params: part },
        }),
      );
    }
    const joinKey = (r: Row) => (childNode === embed.select ? r[rel.childCol] : r.__join);
    const strip = (r: Row) => {
      if (childNode === embed.select) return r;
      const { __join: _j, ...rest } = r;
      return rest;
    };
    if (rel.kind === 'one') {
      const byKey = new Map(children.map((c) => [joinKey(c), strip(c)]));
      for (const r of raw) r[embed.as] = byKey.get(r[rel.parentCol]) ?? null;
    } else {
      const groups = new Map<unknown, Row[]>();
      for (const c of children) {
        const k = joinKey(c);
        groups.set(k, [...(groups.get(k) ?? []), strip(c)]);
      }
      for (const r of raw) r[embed.as] = groups.get(r[rel.parentCol]) ?? [];
    }
  }

  // Shape the output: requested columns (renamed) + embeds; drop join-only columns.
  return raw.map((r) => {
    const out: Row = {};
    for (const o of outputs) out[o.as] = r[o.column];
    for (const { embed } of relations) out[embed.as] = r[embed.as];
    return out;
  });
}

function countRows(ctx: Ctx, tableName: string, where: Sql): number {
  const w = and(readRule(ctx, tableName, 't'), where);
  return Number(one<{ n: number }>(`SELECT count(*) AS n FROM ${q(tableName)} t WHERE ${w.sql}`, ...w.params)?.n ?? 0);
}

// ------------------------------------------------------------------ writes

function returning(ctx: Ctx, tableName: string, select: string | null | undefined, pks: unknown[]): Row[] | null {
  if (select === undefined || select === null) return null;
  const pk = table(tableName).pk!;
  const rows: Row[] = [];
  for (const part of chunk(pks as Param[])) {
    rows.push(...runSelect(ctx, tableName, parseSelect(select), { where: { sql: `t.${q(pk)} IN (${part.map(() => '?').join(', ')})`, params: part } }));
  }
  return rows;
}

function targetPks(tableName: string, rule: Sql, filters: FilterSpec[] | undefined): unknown[] {
  if (!filters?.length) invalid('Updates and deletes need at least one filter.');
  const info = table(tableName);
  const where = and(rule, filtersSql(info, 't', filters));
  return all<Row>(`SELECT t.${q(info.pk!)} AS pk FROM ${q(tableName)} t WHERE ${where.sql}`, ...where.params).map((r) => r.pk);
}

const PUBLIC_TABLES = new Set(['public_cars', 'public_settings', 'public_policies']);

export function executeQuery(ctx: Ctx, req: QueryRequest): QueryResult {
  const tableName = String(req.table ?? '');
  const policy = policyFor(tableName);
  // Visitors may only read the public views (9.2).
  if (!ctx.userId && !ctx.system && !(PUBLIC_TABLES.has(tableName) && req.action === 'select')) {
    throw new ApiError('Sign in to continue.', 'unauthorized', { status: 401, pgCode: 'PGRST301' });
  }
  const info = table(tableName);

  if (req.action === 'select') {
    const where = filtersSql(info, 't', req.filters);
    const count = req.count === 'exact' ? countRows(ctx, tableName, where) : null;
    if (req.head) return { data: null, count };
    const data = runSelect(ctx, tableName, parseSelect(req.select), { where, order: req.order, limit: req.limit, offset: req.offset });
    return { data, count };
  }

  if (info.isView) forbidden();
  const rows = (Array.isArray(req.values) ? req.values : req.values ? [req.values] : []) as Row[];

  if (req.action === 'insert') {
    if (!policy.insert?.(ctx) && !ctx.system) forbidden("You don't have permission to do that.");
    if (!rows.length) invalid('Nothing to insert.');
    const pks = rows.map((r) => insertRow<Row>(ctx, tableName, r)[info.pk!]);
    return { data: returning(ctx, tableName, req.select, pks), count: null };
  }

  if (req.action === 'upsert') {
    const conflict = req.onConflict ?? info.pk!;
    checkColumn(info, conflict);
    const pks: unknown[] = [];
    for (const r of rows) {
      const existing = r[conflict] === undefined ? undefined : one<Row>(`SELECT ${q(info.pk!)} AS pk FROM ${q(tableName)} WHERE ${q(conflict)} = ?`, r[conflict] as Param);
      if (existing) {
        const rule = ctx.system ? TRUE : policy.update ? policy.update(ctx, 't') : FALSE;
        const allowed = one(`SELECT 1 FROM ${q(tableName)} t WHERE t.${q(info.pk!)} = ? AND (${rule.sql})`, existing.pk as Param, ...rule.params);
        if (!allowed) forbidden("You don't have permission to do that.");
        updateRow(ctx, tableName, existing.pk, r);
        pks.push(existing.pk);
      } else {
        if (!policy.insert?.(ctx) && !ctx.system) forbidden("You don't have permission to do that.");
        pks.push(insertRow<Row>(ctx, tableName, r)[info.pk!]);
      }
    }
    return { data: returning(ctx, tableName, req.select, pks), count: null };
  }

  if (req.action === 'update') {
    const rule = ctx.system ? TRUE : policy.update ? policy.update(ctx, 't') : FALSE;
    if (rule.sql === '0') forbidden("You don't have permission to do that.");
    const patch = (rows[0] ?? {}) as Row;
    const pks = targetPks(tableName, rule, req.filters);
    for (const pk of pks) updateRow(ctx, tableName, pk, patch);
    return { data: returning(ctx, tableName, req.select, pks), count: null };
  }

  if (req.action === 'delete') {
    const rule = ctx.system ? TRUE : policy.delete ? policy.delete(ctx, 't') : FALSE;
    if (rule.sql === '0') forbidden("You don't have permission to do that.");
    const pks = targetPks(tableName, rule, req.filters);
    const before = req.select !== undefined && req.select !== null ? returning(ctx, tableName, req.select, pks) : null;
    for (const pk of pks) deleteRow(ctx, tableName, pk);
    return { data: before, count: null };
  }

  return invalid(`Unknown action "${String(req.action)}".`);
}
