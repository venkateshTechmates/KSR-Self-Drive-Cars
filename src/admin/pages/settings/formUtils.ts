// Parsing helpers for the settings forms. Each returns the parsed value or a message that
// says how to fix the input.
import { parseRupees } from '@shared/money.ts';

export interface Parsed<T> {
  value: T;
  error: string | null;
}

/** Whole number in [min, max]. */
export function parseWhole(raw: string, min: number, max: number): Parsed<number> {
  const s = raw.trim();
  const n = /^\d+$/.test(s) ? Number(s) : NaN;
  if (Number.isNaN(n) || n < min || n > max) return { value: 0, error: `Enter a whole number from ${min} to ${max}.` };
  return { value: n, error: null };
}

/** Optional whole number: blank means "not set" (null). */
export function parseOptionalWhole(raw: string, min: number, max: number): Parsed<number | null> {
  if (!raw.trim()) return { value: null, error: null };
  return parseWhole(raw, min, max);
}

/** Rupee amount typed by the Owner, returned as paise. */
export function parseMoney(raw: string, maxRupees = 10_00_000): Parsed<number> {
  const paise = parseRupees(raw.trim() || '0');
  if (paise === null || paise > maxRupees * 100) return { value: 0, error: 'Enter an amount in rupees, for example 1500 or 1500.50.' };
  return { value: paise, error: null };
}

export function parseOptionalMoney(raw: string): Parsed<number | null> {
  if (!raw.trim()) return { value: null, error: null };
  return parseMoney(raw);
}

/** Collects field errors while building a value; `ok` is false once any field fails. */
export class Errors<K extends string = string> {
  map: Partial<Record<K, string>> = {};
  take<T>(key: K, parsed: Parsed<T>): T {
    if (parsed.error) this.map[key] = parsed.error;
    return parsed.value;
  }
  set(key: K, message: string | null | undefined) {
    if (message) this.map[key] = message;
  }
  get ok() {
    return Object.keys(this.map).length === 0;
  }
}

export const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function validUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}
