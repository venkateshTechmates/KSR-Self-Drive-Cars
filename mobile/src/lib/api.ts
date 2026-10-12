// Client for the KSR server: the same endpoints the website uses (server/routes).
//   POST /api/query          table reads (public views for visitors; role rules for staff)
//   POST /api/rpc/<name>     business functions (booking_transition, record_payment, …)
//   POST /api/fn/<name>      submit-booking and other functions
//   /api/auth/*              sign-in, two-step verification, sign-out
// The session is a cookie that Android's networking keeps (and shares with the admin web
// view). Every request carries the X-KSR-Request header the server's CSRF guard asks for.
import { serverUrl } from './server';
import type { Access, Session } from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    /** Machine code from the server, e.g. 'clash', 'validation', 'rate_limited'. */
    readonly code: string | null,
    readonly hint: unknown,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const errorText = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong. Try again.');

const NETWORK = "Couldn't reach KSR. Check your internet connection, or the server address in Settings.";

async function request<T>(path: string, init: { method: 'GET' | 'POST'; body?: unknown } = { method: 'GET' }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(serverUrl() + path, {
      method: init.method,
      credentials: 'include',
      headers: { 'x-ksr-request': '1', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError(NETWORK, 'network', null, 0);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    // Data and RPC errors: { message, details: code, hint }. Functions: { error, code, hint }.
    const j = (json ?? {}) as { message?: string; error?: string; details?: string | null; code?: string; hint?: unknown };
    throw new ApiError(j.message ?? j.error ?? `The server answered ${res.status}.`, j.details ?? j.code ?? null, j.hint ?? null, res.status);
  }
  return json as T;
}

export interface Filter {
  op: string;
  column?: string;
  value?: unknown;
  notOp?: string;
  logic?: string;
}

export interface SelectOptions {
  select?: string;
  filters?: Filter[];
  order?: Array<{ column: string; ascending?: boolean }>;
  limit?: number;
}

/** Read rows (the server applies the caller's role rules). */
export async function select<T>(table: string, opts: SelectOptions = {}): Promise<T[]> {
  const r = await request<{ data: T[] | null }>('/api/query', {
    method: 'POST',
    body: { table, action: 'select', select: opts.select ?? '*', filters: opts.filters ?? [], order: opts.order ?? [], limit: opts.limit ?? null },
  });
  return r.data ?? [];
}

export const eq = (column: string, value: unknown): Filter => ({ op: 'eq', column, value });
export const gte = (column: string, value: unknown): Filter => ({ op: 'gte', column, value });
export const lt = (column: string, value: unknown): Filter => ({ op: 'lt', column, value });
export const isIn = (column: string, values: readonly unknown[]): Filter => ({ op: 'in', column, value: [...values] });
export const notIn = (column: string, values: readonly string[]): Filter => ({ op: 'not', column, notOp: 'in', value: `(${values.join(',')})` });

export const rpc = <T>(name: string, args: Record<string, unknown> = {}) => request<T>(`/api/rpc/${name}`, { method: 'POST', body: args });
export const fn = <T>(name: string, body: Record<string, unknown>) => request<T>(`/api/fn/${name}`, { method: 'POST', body });

export const auth = {
  session: () => request<Session | { user: null }>('/api/auth/session'),
  login: (email: string, password: string) => request<Session>('/api/auth/login', { method: 'POST', body: { email, password } }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST', body: { reason: 'manual' } }),
  mfaEnroll: () => request<{ secret: string; uri: string; qr: string }>('/api/auth/mfa/enroll', { method: 'POST', body: {} }),
  mfaVerify: (code: string) => request<Session>('/api/auth/mfa/verify', { method: 'POST', body: { code } }),
};

/** Is the server there? (Settings checks a new address before saving it.) */
export async function checkServer(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/health`);
    return res.ok && ((await res.json()) as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
}

export type { Access, Session };
