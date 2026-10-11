/* eslint-disable @typescript-eslint/no-explicit-any -- results are cast by the caller, like the untyped supabase-js client this replaces */
// Browser client for the KSR server (same origin). It mirrors the small part of the
// supabase-js interface the screens use — from().select().eq()…, rpc(), storage — so data
// code reads the same, but every call goes to our own API: /api/query, /api/rpc, /api/storage.
// The session is an HttpOnly cookie; all writes carry the X-KSR-Request header (CSRF guard).

export interface ApiErrorShape {
  message: string;
  details: string | null;
  hint: string | null;
  code: string;
  status?: number;
}

export interface ApiResponse<T = any> {
  data: T;
  error: ApiErrorShape | null;
  count: number | null;
  status: number;
}

type Listener = (event: 'expired') => void;
const listeners = new Set<Listener>();

/** Tell listeners the session is gone (a 401 from any API call). */
export const onSessionExpiredNotify = () => listeners.forEach((l) => l('expired'));

/** Notified when the server says the session is gone (401), so the admin can send people to sign in. */
export function onSessionExpired(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const NETWORK_ERROR: ApiErrorShape = {
  message: "Couldn't reach the server. Check your connection and try again.",
  details: 'network',
  hint: null,
  code: 'network',
};

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const API_HEADERS = { 'x-ksr-request': '1' };

/** POST JSON to an API path and normalise the result into { data, error }. */
export async function apiPost<T = any>(path: string, body: unknown, signal?: AbortSignal): Promise<{ data: T | null; error: ApiErrorShape | null; status: number }> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...API_HEADERS },
      body: JSON.stringify(body ?? {}),
      signal,
    });
  } catch {
    return { data: null, error: NETWORK_ERROR, status: 0 };
  }
  const text = await res.text();
  const json = parseJson(text);
  if (!res.ok) {
    if (res.status === 401) onSessionExpiredNotify();
    const e = (json ?? {}) as Partial<ApiErrorShape> & { error?: string };
    return {
      data: null,
      status: res.status,
      error: { message: e.message ?? e.error ?? `Request failed (${res.status}).`, details: e.details ?? null, hint: e.hint ?? null, code: e.code ?? String(res.status), status: res.status },
    };
  }
  return { data: json as T, error: null, status: res.status };
}

// ------------------------------------------------------------------ query builder

interface FilterSpec {
  op: string;
  column?: string;
  value?: unknown;
  notOp?: string;
  logic?: string;
}

interface QueryRequest {
  table: string;
  action: 'select' | 'insert' | 'update' | 'upsert' | 'delete';
  select?: string | null;
  count?: 'exact' | null;
  head?: boolean;
  filters: FilterSpec[];
  order: Array<{ column: string; ascending?: boolean; nullsFirst?: boolean }>;
  limit?: number | null;
  offset?: number | null;
  values?: unknown;
  onConflict?: string | null;
}

export class QueryBuilder<T = any> implements PromiseLike<ApiResponse<T>> {
  private req: QueryRequest;
  private mode: 'many' | 'single' | 'maybe' = 'many';
  private signal?: AbortSignal;

  constructor(table: string) {
    this.req = { table, action: 'select', select: '*', filters: [], order: [] };
  }

  select(columns = '*', opts: { count?: 'exact'; head?: boolean } = {}): this {
    // After insert/update/upsert/delete, select() asks for the written rows back.
    this.req.select = columns;
    if (this.req.action === 'select') {
      this.req.count = opts.count ?? null;
      this.req.head = opts.head ?? false;
    }
    return this;
  }

  insert(values: unknown): this {
    Object.assign(this.req, { action: 'insert', values, select: null });
    return this;
  }

  update(values: unknown): this {
    Object.assign(this.req, { action: 'update', values, select: null });
    return this;
  }

  upsert(values: unknown, opts: { onConflict?: string } = {}): this {
    Object.assign(this.req, { action: 'upsert', values, select: null, onConflict: opts.onConflict ?? null });
    return this;
  }

  delete(): this {
    Object.assign(this.req, { action: 'delete', select: null });
    return this;
  }

  private push(op: string, column: string, value: unknown): this {
    this.req.filters.push({ op, column, value });
    return this;
  }

  eq = (column: string, value: unknown) => this.push('eq', column, value);
  neq = (column: string, value: unknown) => this.push('neq', column, value);
  gt = (column: string, value: unknown) => this.push('gt', column, value);
  gte = (column: string, value: unknown) => this.push('gte', column, value);
  lt = (column: string, value: unknown) => this.push('lt', column, value);
  lte = (column: string, value: unknown) => this.push('lte', column, value);
  like = (column: string, pattern: string) => this.push('like', column, pattern);
  ilike = (column: string, pattern: string) => this.push('ilike', column, pattern);
  is = (column: string, value: null | boolean) => this.push('is', column, value === null ? 'null' : String(value));
  in = (column: string, values: readonly unknown[]) => this.push('in', column, [...values]);
  overlaps = (column: string, values: readonly unknown[]) => this.push('ov', column, [...values]);
  contains = (column: string, values: readonly unknown[]) => this.push('cs', column, [...values]);

  not(column: string, op: string, value: unknown): this {
    this.req.filters.push({ op: 'not', column, notOp: op, value: op === 'is' && value === null ? 'null' : value });
    return this;
  }

  /** PostgREST logic string, e.g. 'status.eq.active,and(a.gt.1,b.lt.2)'. */
  or(logic: string): this {
    this.req.filters.push({ op: 'or', logic });
    return this;
  }

  order(column: string, opts: { ascending?: boolean; nullsFirst?: boolean } = {}): this {
    this.req.order.push({ column, ascending: opts.ascending, nullsFirst: opts.nullsFirst });
    return this;
  }

  limit(n: number): this {
    this.req.limit = n;
    return this;
  }

  range(from: number, to: number): this {
    this.req.offset = from;
    this.req.limit = to - from + 1;
    return this;
  }

  single(): this {
    this.mode = 'single';
    return this;
  }

  maybeSingle(): this {
    this.mode = 'maybe';
    return this;
  }

  /** Typing helper kept for compatibility. */
  returns<U>(): QueryBuilder<U> {
    return this as unknown as QueryBuilder<U>;
  }

  abortSignal(signal: AbortSignal): this {
    this.signal = signal;
    return this;
  }

  private async execute(): Promise<ApiResponse<T>> {
    const r = await apiPost<{ data: unknown; count: number | null }>('/api/query', this.req, this.signal);
    if (r.error) return { data: null as T, error: r.error, count: null, status: r.status };
    let data = r.data?.data ?? null;
    if (this.mode !== 'many' && Array.isArray(data)) {
      if (data.length > 1 || (this.mode === 'single' && data.length === 0)) {
        return {
          data: null as T,
          count: null,
          status: 406,
          error: { message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${data.length} rows`, hint: null, code: 'PGRST116', status: 406 },
        };
      }
      data = data[0] ?? null;
    }
    return { data: data as T, error: null, count: r.data?.count ?? null, status: r.status };
  }

  then<R1 = ApiResponse<T>, R2 = never>(
    onfulfilled?: ((value: ApiResponse<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

// ------------------------------------------------------------------ storage (car photos)

function bucket(name: 'car-photos') {
  return {
    async upload(path: string, file: Blob, opts: { contentType?: string; upsert?: boolean; cacheControl?: string } = {}) {
      try {
        const res = await fetch(`/api/storage/${name}/${path}${opts.upsert ? '?upsert=1' : ''}`, {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'content-type': opts.contentType ?? file.type, ...API_HEADERS },
          body: file,
        });
        if (!res.ok) {
          const e = (await res.json().catch(() => ({}))) as { error?: string; message?: string; code?: string };
          return { data: null, error: { message: e.error ?? e.message ?? `Upload failed (${res.status}).`, details: e.code ?? null, hint: null, code: String(res.status), status: res.status } };
        }
        return { data: { path }, error: null };
      } catch {
        return { data: null, error: NETWORK_ERROR };
      }
    },
    async remove(paths: string[]) {
      const r = await apiPost(`/api/storage/${name}/remove`, { paths });
      return { data: r.data, error: r.error };
    },
    getPublicUrl(path: string) {
      return { data: { publicUrl: `/media/${name}/${path}` } };
    },
  };
}

export const api = {
  from: <T = any>(table: string) => new QueryBuilder<T>(table),
  rpc: async <T = any>(name: string, args: Record<string, unknown> = {}): Promise<{ data: T; error: ApiErrorShape | null }> => {
    const r = await apiPost<T>(`/api/rpc/${name}`, args);
    return { data: r.data as T, error: r.error };
  },
  storage: { from: bucket },
};
