// Document centre list (DOC-14): filters kept in the URL so other screens and emails can link to a view.
import { DOC_OWNER_TYPES, DOC_STATUSES, type DocOwnerType, type DocStatus } from '@shared/constants.ts';
import { KYC_DOC_TYPES } from '@shared/documents.ts';
import { addDaysIso, isIsoDate, istStartOfDay } from '@shared/time.ts';
import { normalizePhone } from '@shared/validation.ts';
import { supabase } from '@/integrations/supabase/client';
import { toAppError, unwrap } from '@/lib/errors';
import type { DocumentRow } from '@/types/db';
import { cleanSearch, searchCustomers } from '../customers/customerSearch';

export const PAGE_SIZE = 50;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type StatusFilter = 'current' | 'all' | DocStatus;
export type ExpiryWindow = '' | 'expired' | '7' | '30' | '60';

export const EXPIRY_WINDOWS: Array<{ value: ExpiryWindow; label: string }> = [
  { value: '', label: 'Any' },
  { value: 'expired', label: 'Expired' },
  { value: '7', label: 'Expires within 7 days' },
  { value: '30', label: 'Expires within 30 days' },
  { value: '60', label: 'Expires within 60 days' },
];

export interface DocFilters {
  category: DocOwnerType | '';
  type: string;
  status: StatusFilter;
  expiry: ExpiryWindow;
  car: string;
  customer: string;
  /** Staff user id, or "customer_link" for files sent by customers. */
  by: string;
  from: string;
  to: string;
}

export const FILTER_KEYS: Array<keyof DocFilters> = ['category', 'type', 'status', 'expiry', 'car', 'customer', 'by', 'from', 'to'];

const uuidOr = (v: string | null) => (v && UUID_RE.test(v) ? v : '');
const dateOr = (v: string | null) => (v && isIsoDate(v) ? v : '');

/** Supported params: category, type, status (current|all|<status>), expiry (expired|7|30|60), car, customer, by, from, to, q, doc. */
export function readFilters(p: URLSearchParams): DocFilters {
  const category = p.get('category') ?? '';
  const status = p.get('status') ?? '';
  const expiry = p.get('expiry') ?? '';
  const by = p.get('by') ?? '';
  return {
    category: (DOC_OWNER_TYPES as readonly string[]).includes(category) ? (category as DocOwnerType) : '',
    type: /^[a-z][a-z0-9_]{1,40}$/.test(p.get('type') ?? '') ? p.get('type')! : '',
    status: status === 'all' || (DOC_STATUSES as readonly string[]).includes(status) ? (status as StatusFilter) : 'current',
    expiry: EXPIRY_WINDOWS.some((w) => w.value === expiry) ? (expiry as ExpiryWindow) : '',
    car: uuidOr(p.get('car')),
    customer: uuidOr(p.get('customer')),
    by: by === 'customer_link' ? by : uuidOr(by),
    from: dateOr(p.get('from')),
    to: dateOr(p.get('to')),
  };
}

export const countActiveFilters = (f: DocFilters) => FILTER_KEYS.filter((k) => (k === 'status' ? f.status !== 'current' : Boolean(f[k]))).length;

export type DocListRow = DocumentRow & {
  customer: { id: string; full_name: string; erased_at: string | null } | null;
  booking: { id: string; booking_code: string; customer: { id: string; full_name: string } | null } | null;
  car: { id: string; display_name: string; registration_number: string | null } | null;
};

const DOC_SELECT =
  '*, customer:customers(id, full_name, erased_at), booking:bookings(id, booking_code, customer:customers(id, full_name)), car:cars(id, display_name, registration_number)';

async function bookingIdsFor(customerIds: string[], limit = 100): Promise<string[]> {
  if (customerIds.length === 0) return [];
  const rows = (unwrap(await supabase.from('bookings').select('id').in('customer_id', customerIds).limit(limit)) ?? []) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/** "TS09AB1234" → "TS%09%AB%1234", so spacing differences in what staff type don't matter. */
const looseRegistration = (compact: string) => compact.replace(/([A-Z])(?=\d)|(\d)(?=[A-Z])/g, '$1$2%');

/**
 * OR filter for the search box: customer name or mobile, car registration, booking code, or the visible
 * last digits of a document number (numbers are stored masked). Null means nothing can match.
 */
async function documentSearchFilter(raw: string): Promise<string | null> {
  const t = cleanSearch(raw);
  if (!t) return null;
  const compact = t.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const isCode = /^KSR\d/.test(compact);

  const [customers, cars, codeBookings] = await Promise.all([
    isCode ? Promise.resolve([]) : searchCustomers(t, { limit: 15, includeErased: true }),
    compact.length >= 2 && !isCode
      ? supabase
          .from('cars')
          .select('id')
          .or(`registration_number.ilike."%${looseRegistration(compact)}%",display_name.ilike."%${t}%"`)
          .limit(20)
          .then((r) => (unwrap(r) ?? []) as Array<{ id: string }>)
      : Promise.resolve([]),
    isCode
      ? supabase
          .from('bookings')
          .select('id')
          .ilike('booking_code', `%${t.toUpperCase().replace(/\s/g, '')}%`)
          .limit(20)
          .then((r) => (unwrap(r) ?? []) as Array<{ id: string }>)
      : Promise.resolve([]),
  ]);
  const customerIds = customers.map((c) => c.id);
  // Kept small: every id goes into the request URL.
  const bookingIds = [...codeBookings.map((b) => b.id), ...(await bookingIdsFor(customerIds, 60))];

  const parts: string[] = [];
  if (customerIds.length) parts.push(`customer_id.in.(${customerIds.join(',')})`);
  if (bookingIds.length) parts.push(`booking_id.in.(${bookingIds.join(',')})`);
  if (cars.length) parts.push(`car_id.in.(${cars.map((c) => c.id).join(',')})`);
  if (compact.length >= 3 && !isCode && !normalizePhone(t)) parts.push(`doc_number_masked.ilike."%${compact.slice(-4)}"`);
  return parts.length ? parts.join(',') : null;
}

export async function fetchDocuments(f: DocFilters, q: string, todayIso: string, limit: number): Promise<{ rows: DocListRow[]; total: number }> {
  let query = supabase.from('documents').select(DOC_SELECT, { count: 'exact' }).is('deleted_at', null);
  if (f.category) query = query.eq('owner_type', f.category);
  if (f.type) query = query.eq('doc_type', f.type);
  if (f.status === 'current') query = query.neq('status', 'superseded');
  else if (f.status !== 'all') query = query.eq('status', f.status);
  if (f.expiry === 'expired') query = query.lt('expiry_date', todayIso);
  else if (f.expiry) query = query.gte('expiry_date', todayIso).lte('expiry_date', addDaysIso(todayIso, Number(f.expiry)));
  if (f.car) query = query.eq('car_id', f.car);
  // OR-groups are combined into one logic tree below; repeated `or` params are ambiguous.
  const orGroups: string[] = [];
  if (f.customer) {
    // The customer's own documents plus those on their bookings.
    const bookingIds = await bookingIdsFor([f.customer], 200);
    orGroups.push([`customer_id.eq.${f.customer}`, ...(bookingIds.length ? [`booking_id.in.(${bookingIds.join(',')})`] : [])].join(','));
  }
  if (f.by === 'customer_link') query = query.eq('uploaded_via', 'customer_link');
  else if (f.by) query = query.eq('uploaded_by', f.by);
  if (f.from) query = query.gte('created_at', istStartOfDay(f.from).toISOString());
  if (f.to) query = query.lt('created_at', istStartOfDay(addDaysIso(f.to, 1)).toISOString());
  if (q) {
    const filter = await documentSearchFilter(q);
    if (!filter) return { rows: [], total: 0 };
    orGroups.push(filter);
  }
  if (orGroups.length === 1) query = query.or(orGroups[0]);
  else if (orGroups.length > 1) query = query.or(`and(${orGroups.map((g) => `or(${g})`).join(',')})`);
  query = f.expiry
    ? query.order('expiry_date', { ascending: true }).order('created_at', { ascending: false })
    : query.order('created_at', { ascending: false });
  const { data, error, count } = await query.range(0, limit - 1);
  if (error) throw toAppError(error);
  return { rows: (data ?? []) as unknown as DocListRow[], total: count ?? 0 };
}

export interface DocAlerts {
  expiredPapers: number;
  expiringPapers: number;
  pendingKyc: number;
}

/** Counts for the summary at the top (DOC-12, DSH-05). */
export async function fetchDocAlerts(todayIso: string): Promise<DocAlerts> {
  const base = () =>
    supabase.from('documents').select('id', { count: 'exact', head: true }).is('deleted_at', null).neq('status', 'superseded');
  const [expired, expiring, pending] = await Promise.all([
    base().eq('owner_type', 'car').lt('expiry_date', todayIso),
    base().eq('owner_type', 'car').gte('expiry_date', todayIso).lte('expiry_date', addDaysIso(todayIso, 30)),
    base().eq('status', 'pending').in('doc_type', [...KYC_DOC_TYPES]),
  ]);
  for (const r of [expired, expiring, pending]) if (r.error) throw toAppError(r.error);
  return { expiredPapers: expired.count ?? 0, expiringPapers: expiring.count ?? 0, pendingKyc: pending.count ?? 0 };
}

export async function fetchDocument(id: string): Promise<DocumentRow | null> {
  return unwrap(await supabase.from('documents').select('*').eq('id', id).maybeSingle()) as DocumentRow | null;
}

/** Owner label for a document row, e.g. for screen-reader names. */
export function ownerName(d: DocListRow): string {
  switch (d.owner_type) {
    case 'customer':
      return d.customer?.full_name ?? 'Customer';
    case 'booking':
      return d.booking?.booking_code ?? 'Booking';
    case 'car':
      return d.car?.display_name ?? 'Vehicle';
    default:
      return 'Business';
  }
}
