// Reading named p_* arguments safely.
import { fail } from '../errors.ts';
import type { RpcArgs } from './registry.ts';

const isBlank = (v: unknown) => v === undefined || v === null;

/** String or null (empty strings are kept; trim yourself where it matters). */
export function str(a: RpcArgs, k: string): string | null {
  const v = a[k];
  if (isBlank(v)) return null;
  return typeof v === 'string' ? v : String(v);
}

export function reqStr(a: RpcArgs, k: string, message = 'Missing value.'): string {
  const v = str(a, k);
  if (v === null || v.trim() === '') fail(message, k.replace(/^p_/, ''));
  return v;
}

/** Trimmed non-empty string or null. */
export function text(a: RpcArgs, k: string): string | null {
  const v = str(a, k)?.trim();
  return v ? v : null;
}

export function int(a: RpcArgs, k: string): number | null {
  const v = a[k];
  if (isBlank(v) || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n)) fail('Enter a whole number.', k.replace(/^p_/, ''));
  return n;
}

export function bool(a: RpcArgs, k: string): boolean {
  const v = a[k];
  return v === true || v === 'true' || v === 1 || v === '1';
}

/** ISO timestamp (normalised to toISOString) or null. */
export function ts(a: RpcArgs, k: string): string | null {
  const v = a[k];
  if (isBlank(v) || v === '') return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) fail('Enter a valid date and time.', k.replace(/^p_/, ''));
  return d.toISOString();
}

/** YYYY-MM-DD or null. */
export function date(a: RpcArgs, k: string): string | null {
  const v = a[k];
  if (isBlank(v) || v === '') return null;
  const s = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) fail('Enter a valid date.', k.replace(/^p_/, ''));
  return s;
}

export function json<T = unknown>(a: RpcArgs, k: string, fallback: T): T {
  const v = a[k];
  if (isBlank(v)) return fallback;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      fail('Invalid data.', k.replace(/^p_/, ''));
    }
  }
  return v as T;
}

/** One of an allowed set of values, or null. */
export function oneOf<T extends string>(a: RpcArgs, k: string, allowed: readonly T[], message = 'Choose a valid option.'): T | null {
  const v = str(a, k);
  if (v === null) return null;
  if (!allowed.includes(v as T)) fail(message, k.replace(/^p_/, ''));
  return v as T;
}
