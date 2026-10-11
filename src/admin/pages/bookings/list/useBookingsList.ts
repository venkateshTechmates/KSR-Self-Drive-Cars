// Bookings list query (BKA-01): filters live in the URL so "Back" from a booking keeps them.
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { BOOKING_SOURCES, type BookingSource, type BookingStatus } from '@shared/constants.ts';
import { addDaysIso, isIsoDate, istStartOfDay } from '@shared/time.ts';
import { supabase } from '@/integrations/supabase/client';
import { toAppError, unwrap } from '@/lib/errors';
import type { BookingWithRefs, Car } from '@/types/db';
import { BOOKING_SELECT } from '../../../hooks/bookings';
import { qk } from '../../../hooks/queries';

export type ListView = 'upcoming' | 'past' | 'all';
/** "Overdue" is not stored: Active and past the return time (Section 7). */
export type StatusFilter = BookingStatus | 'overdue';

export const STATUS_FILTERS: readonly StatusFilter[] = [
  'requested',
  'confirmed',
  'active',
  'overdue',
  'returned',
  'closed',
  'rejected',
  'cancelled',
  'no_show',
];

export const VIEW_LABELS: Record<ListView, string> = { upcoming: 'Upcoming', past: 'Past', all: 'All' };

export const PAGE_SIZE = 50;

export interface ListFilters {
  view: ListView;
  q: string;
  statuses: StatusFilter[];
  carId: string;
  source: BookingSource | '';
  /** Pickup on or after this IST date (YYYY-MM-DD). */
  from: string;
  /** Pickup on or before this IST date (YYYY-MM-DD). */
  to: string;
}

export const DEFAULT_FILTERS: ListFilters = { view: 'upcoming', q: '', statuses: [], carId: '', source: '', from: '', to: '' };

export function readFilters(p: URLSearchParams): ListFilters {
  const view = p.get('view');
  const source = p.get('source') ?? '';
  const from = p.get('from') ?? '';
  const to = p.get('to') ?? '';
  return {
    view: view === 'past' || view === 'all' ? view : 'upcoming',
    q: p.get('q') ?? '',
    statuses: (p.get('status') ?? '')
      .split(',')
      .filter((s): s is StatusFilter => (STATUS_FILTERS as readonly string[]).includes(s)),
    carId: p.get('car') ?? '',
    source: (BOOKING_SOURCES as readonly string[]).includes(source) ? (source as BookingSource) : '',
    from: isIsoDate(from) ? from : '',
    to: isIsoDate(to) ? to : '',
  };
}

export function writeFilters(f: ListFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.view !== 'upcoming') p.set('view', f.view);
  if (f.q.trim()) p.set('q', f.q.trim());
  if (f.statuses.length) p.set('status', f.statuses.join(','));
  if (f.carId) p.set('car', f.carId);
  if (f.source) p.set('source', f.source);
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  return p;
}

/** Number of filters set besides the view and the search box. */
export const extraFilterCount = (f: ListFilters) =>
  [f.carId, f.source, f.from, f.to].filter(Boolean).length;

/** Quote a value inside a PostgREST or=() tree; reserved characters are then safe. */
const quoted = (v: string) => `"${v.replace(/["\\]/g, '')}"`;

/** Customer ids whose name or mobile matches (RLS limits Staff to today's customers). */
async function matchCustomers(term: string): Promise<string[]> {
  const conds: string[] = [];
  const name = term.replace(/[%_*]/g, ' ').trim();
  if (name.length >= 2) conds.push(`full_name.ilike.${quoted(`%${name}%`)}`);
  const digits = term.replace(/\D/g, '');
  if (digits.length >= 4) conds.push(`phone.ilike.${quoted(`%${digits.length > 10 ? digits.slice(-10) : digits}%`)}`);
  if (!conds.length) return [];
  const rows = unwrap(await supabase.from('customers').select('id').or(conds.join(',')).limit(100)) as { id: string }[];
  return rows.map((r) => r.id);
}

/** or=() conditions for the search box: booking code, customer name or mobile, car registration or name. */
async function searchTree(term: string, cars: Car[]): Promise<string | null> {
  const parts: string[] = [];
  const code = term.toUpperCase().replace(/[^A-Z0-9-]/g, '');
  if (code.length >= 2) parts.push(`booking_code.ilike.${quoted(`%${code}%`)}`);

  const reg = term.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const lower = term.toLowerCase();
  const carIds = cars
    .filter(
      (c) =>
        (reg.length >= 2 && (c.registration_number ?? '').includes(reg)) ||
        (lower.length >= 2 && c.display_name.toLowerCase().includes(lower)),
    )
    .map((c) => c.id);
  if (carIds.length) parts.push(`car_id.in.(${carIds.join(',')})`);

  const customerIds = await matchCustomers(term);
  if (customerIds.length) parts.push(`customer_id.in.(${customerIds.join(',')})`);
  return parts.length ? parts.join(',') : null;
}

export interface BookingsPage {
  rows: BookingWithRefs[];
  count: number;
}

async function fetchBookings(f: ListFilters, limit: number, todayIso: string, cars: Car[]): Promise<BookingsPage> {
  const nowIso = new Date().toISOString();
  const todayStart = istStartOfDay(todayIso).toISOString();
  let query = supabase.from('bookings').select(BOOKING_SELECT, { count: 'exact' });

  if (f.view === 'upcoming') query = query.gte('pickup_at', todayStart);
  if (f.view === 'past') query = query.lt('pickup_at', todayStart);
  if (f.from) query = query.gte('pickup_at', istStartOfDay(f.from).toISOString());
  if (f.to) query = query.lt('pickup_at', istStartOfDay(addDaysIso(f.to, 1)).toISOString());
  if (f.carId) query = query.eq('car_id', f.carId);
  if (f.source) query = query.eq('source', f.source);

  const trees: string[] = [];
  const plain = f.statuses.filter((s): s is BookingStatus => s !== 'overdue');
  const overdue = f.statuses.includes('overdue');
  if (overdue && !plain.length) query = query.eq('status', 'active').lt('return_due_at', nowIso);
  else if (!overdue && plain.length) query = query.in('status', plain);
  else if (overdue && plain.length) {
    trees.push(`status.in.(${plain.join(',')}),and(status.eq.active,return_due_at.lt.${quoted(nowIso)})`);
  }

  const term = f.q.trim();
  if (term) {
    const tree = await searchTree(term, cars);
    if (!tree) return { rows: [], count: 0 };
    trees.push(tree);
  }
  if (trees.length === 1) query = query.or(trees[0]);
  if (trees.length === 2) query = query.or(`and(or(${trees[0]}),or(${trees[1]}))`);

  // BKA-01: upcoming = soonest first; past and all = most recent first.
  const ascending = f.view === 'upcoming';
  const res = await query
    .order('pickup_at', { ascending })
    .order('booking_code', { ascending })
    .range(0, limit - 1);
  if (res.error) throw toAppError(res.error);
  return { rows: (res.data ?? []) as BookingWithRefs[], count: res.count ?? 0 };
}

export function useBookingsList(f: ListFilters, limit: number, todayIso: string, cars: Car[] | undefined) {
  const needsCars = Boolean(f.q.trim());
  return useQuery({
    queryKey: [...qk.bookings, 'list', f, limit, todayIso],
    queryFn: () => fetchBookings(f, limit, todayIso, cars ?? []),
    // Registration search matches against the cars list, so wait for it when searching.
    enabled: !needsCars || cars !== undefined,
    placeholderData: keepPreviousData,
  });
}
