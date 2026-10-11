// Customer search (CUS-02), shared by the customers, document centre and privacy request screens.
import { useEffect, useState } from 'react';
import { normalizeDl } from '@shared/validation.ts';
import { api } from '@/integrations/api/client';
import { unwrap } from '@/lib/errors';
import type { Customer } from '@/types/db';

/** Drop characters that would break a PostgREST filter string, and squeeze spaces. */
export const cleanSearch = (q: string) =>
  q
    .replace(/[,()"\\%*_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Digits to match against stored "+91XXXXXXXXXX" numbers, or null when there are too few to search by. */
export function phoneSearchDigits(q: string): string | null {
  let d = q.replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d.length >= 3 ? d : null;
}

/** OR filter over name, mobile and licence number, or null for an empty search. */
export function customerSearchFilter(q: string): string | null {
  const t = cleanSearch(q);
  if (!t) return null;
  const parts = [`full_name.ilike."%${t}%"`];
  const digits = phoneSearchDigits(t);
  if (digits) parts.push(`phone.ilike."%${digits}%"`);
  const dl = normalizeDl(t);
  if (dl.length >= 3 && /^[A-Z0-9]+$/.test(dl)) parts.push(`dl_number.ilike."%${dl}%"`);
  return parts.join(',');
}

export async function searchCustomers(q: string, opts: { limit?: number; includeErased?: boolean } = {}): Promise<Customer[]> {
  let query = api.from('customers').select('*');
  const filter = customerSearchFilter(q);
  if (filter) query = query.or(filter);
  if (!opts.includeErased) query = query.is('erased_at', null);
  return unwrap(await query.order('full_name').limit(opts.limit ?? 20)) as Customer[];
}

/** Run an `.in()` lookup in chunks so long id lists don't overflow the URL. */
export async function inChunks<T>(ids: string[], fetchChunk: (chunk: string[]) => Promise<T[]>, size = 100): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += size) out.push(...(await fetchChunk(ids.slice(i, i + size))));
  return out;
}

/** The value, updated `ms` after it stops changing (for search boxes). */
export function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** "XXXX XXXX 1234": only the last 4 Aadhaar digits are ever shown (AAD-03). */
export const maskedAadhaar = (last4: string | null | undefined) => (last4 ? `XXXX XXXX ${last4}` : null);

/** True if free text contains something shaped like a full 12-digit Aadhaar number (AC-03). */
export const containsFullAadhaar = (text: string) => /(^|\D)[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}(?!\d)/.test(text);
