// Dashboard queries (DSH-01..06). Booking queries sit under qk.bookings so booking changes
// elsewhere refresh the dashboard too; "now" comparisons are done in render with useNow().
import { useQuery } from '@tanstack/react-query';
import { BOOKING_FLAGS, type BookingStatus } from '@shared/constants.ts';
import { addDaysIso, istStartOfDay } from '@shared/time.ts';
import { api } from '@/integrations/api/client';
import { toAppError, unwrap } from '@/lib/errors';
import type { BookingWithRefs, Car, DocumentRow, MaintenanceWindow, UtilisationRow } from '@/types/db';
import { BOOKING_SELECT } from '../../hooks/bookings';
import { qk } from '../../hooks/queries';

const REFRESH = { refetchInterval: 120_000 } as const;

const bookings = () => api.from('bookings').select(BOOKING_SELECT);

/** DSH-01: Requested bookings, oldest first. */
export function useRequestedBookings(enabled: boolean) {
  return useQuery({
    queryKey: [...qk.bookings, 'dashboard', 'requested'],
    enabled,
    ...REFRESH,
    queryFn: async () =>
      unwrap(await bookings().eq('status', 'requested').order('created_at').limit(50)) as BookingWithRefs[],
  });
}

/** DSH-01: Confirmed bookings with a flag (Requested ones show their flags in the list above). */
export function useFlaggedBookings(enabled: boolean) {
  return useQuery({
    queryKey: [...qk.bookings, 'dashboard', 'flagged'],
    enabled,
    ...REFRESH,
    queryFn: async () =>
      unwrap(
        await bookings()
          .eq('status', 'confirmed')
          .overlaps('flags', [...BOOKING_FLAGS])
          .order('pickup_at')
          .limit(50),
      ) as BookingWithRefs[],
  });
}

const NOT_PICKING_UP: BookingStatus[] = ['rejected', 'cancelled'];
const RETURNING: BookingStatus[] = ['confirmed', 'active', 'returned', 'closed'];

/** DSH-02: pickups and returns on an IST day. */
export function useTodayBookings(todayIso: string) {
  return useQuery({
    queryKey: [...qk.bookings, 'dashboard', 'today', todayIso],
    ...REFRESH,
    queryFn: async () => {
      const start = istStartOfDay(todayIso).toISOString();
      const end = istStartOfDay(addDaysIso(todayIso, 1)).toISOString();
      const [pickups, returns] = await Promise.all([
        bookings()
          .gte('pickup_at', start)
          .lt('pickup_at', end)
          .not('status', 'in', `(${NOT_PICKING_UP.join(',')})`)
          .order('pickup_at'),
        bookings().gte('return_due_at', start).lt('return_due_at', end).in('status', RETURNING).order('return_due_at'),
      ]);
      return { pickups: unwrap(pickups) as BookingWithRefs[], returns: unwrap(returns) as BookingWithRefs[] };
    },
  });
}

/** Active bookings: overdue ones (DSH-03) and cars on trip (DSH-04). */
export function useActiveBookings() {
  return useQuery({
    queryKey: [...qk.bookings, 'dashboard', 'active'],
    ...REFRESH,
    queryFn: async () => unwrap(await bookings().eq('status', 'active').order('return_due_at')) as BookingWithRefs[],
  });
}

/** Maintenance windows that have not ended yet; the page picks the ones covering "now". */
export function useOpenMaintenance(enabled: boolean) {
  return useQuery({
    queryKey: [...qk.cars, 'dashboard', 'maintenance'],
    enabled,
    ...REFRESH,
    queryFn: async () =>
      unwrap(
        await api.from('maintenance_windows').select('*').gt('ends_at', new Date().toISOString()).order('starts_at'),
      ) as MaintenanceWindow[],
  });
}

export type FleetState = 'available' | 'on_trip' | 'maintenance' | 'inactive';

export const FLEET_STATE_LABELS: Record<FleetState, string> = {
  available: 'Available',
  on_trip: 'On trip',
  maintenance: 'In maintenance',
  inactive: 'Inactive',
};

export interface FleetEntry {
  car: Car;
  state: FleetState;
  booking?: BookingWithRefs;
  maintenance?: MaintenanceWindow;
}

/** DSH-04: where each car is right now. A car out on a trip counts as On trip whatever else applies. */
export function classifyFleet(cars: Car[], active: BookingWithRefs[], windows: MaintenanceWindow[], now: number): FleetEntry[] {
  return cars.map((car) => {
    const booking = active.find((b) => b.car_id === car.id);
    if (booking) return { car, state: 'on_trip', booking };
    const maintenance = windows.find(
      (w) => w.car_id === car.id && new Date(w.starts_at).getTime() <= now && new Date(w.ends_at).getTime() > now,
    );
    if (maintenance) return { car, state: 'maintenance', maintenance };
    if (car.status === 'inactive') return { car, state: 'inactive' };
    return { car, state: 'available' };
  });
}

export type PaperAlert = Pick<DocumentRow, 'id' | 'car_id' | 'doc_type' | 'expiry_date' | 'status' | 'version'>;

/** DSH-05: current vehicle papers that have expired or expire within 30 days. */
export function useCarPaperAlerts(todayIso: string, enabled: boolean) {
  return useQuery({
    queryKey: [...qk.documents, 'dashboard', 'papers', todayIso],
    enabled,
    ...REFRESH,
    queryFn: async () => {
      const rows = unwrap(
        await api
          .from('documents')
          .select('id, car_id, doc_type, expiry_date, status, version')
          .eq('owner_type', 'car')
          .is('deleted_at', null)
          .not('status', 'in', '(superseded,rejected)')
          .not('expiry_date', 'is', null)
          .lte('expiry_date', addDaysIso(todayIso, 30))
          .order('expiry_date'),
      ) as PaperAlert[];
      // Keep only the newest version per car and type, in case an older one was not superseded.
      const newest = new Map<string, PaperAlert>();
      for (const r of rows) {
        const key = `${r.car_id}:${r.doc_type}`;
        const seen = newest.get(key);
        if (!seen || r.version > seen.version) newest.set(key, r);
      }
      return [...newest.values()].sort((a, b) => (a.expiry_date ?? '').localeCompare(b.expiry_date ?? ''));
    },
  });
}

export interface PendingKycDoc {
  id: string;
  customer_id: string | null;
  doc_type: string;
  created_at: string;
  uploaded_via: DocumentRow['uploaded_via'];
  customer: { id: string; full_name: string } | null;
}

/** DSH-05: customer documents waiting for verification. */
export function usePendingKyc(enabled: boolean) {
  return useQuery({
    queryKey: [...qk.documents, 'dashboard', 'pending-kyc'],
    enabled,
    ...REFRESH,
    queryFn: async () =>
      unwrap(
        await api
          .from('documents')
          .select('id, customer_id, doc_type, created_at, uploaded_via, customer:customers(id, full_name)')
          .eq('owner_type', 'customer')
          .eq('status', 'pending')
          .is('deleted_at', null)
          .order('created_at')
          .limit(100),
      ) as unknown as PendingKycDoc[],
  });
}

const pad = (n: number) => String(n).padStart(2, '0');

/** First day of the IST month containing `todayIso`, and of the next month. */
export function monthBounds(todayIso: string): { startIso: string; nextIso: string } {
  const [y, m] = todayIso.split('-').map(Number);
  return {
    startIso: `${y}-${pad(m)}-01`,
    nextIso: m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`,
  };
}

export interface MonthStats {
  completed: number;
  revenuePaise: number;
  /** Hours rented ÷ hours available across the fleet, 0..1; null when no hours were available. */
  utilisation: number | null;
  hoursRented: number;
  hoursAvailable: number;
}

/** DSH-06 (P1): this IST month so far. */
export function useMonthStats(todayIso: string, enabled: boolean) {
  const { startIso, nextIso } = monthBounds(todayIso);
  return useQuery({
    queryKey: [...qk.payments, 'dashboard', 'month', startIso, todayIso],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<MonthStats> => {
      const from = istStartOfDay(startIso);
      const to = istStartOfDay(nextIso);
      const until = new Date(Math.min(Date.now(), to.getTime()));
      const [done, pays, util] = await Promise.all([
        api
          .from('bookings')
          .select('id', { count: 'exact', head: true })
          .in('status', ['returned', 'closed'])
          .gte('actual_return_at', from.toISOString())
          .lt('actual_return_at', to.toISOString()),
        api
          .from('payments')
          .select('amount_paise, type')
          .in('type', ['rent', 'extra', 'refund'])
          .gte('received_at', from.toISOString())
          .lt('received_at', to.toISOString()),
        api.rpc('report_utilisation', { p_from: from.toISOString(), p_to: until.toISOString() }),
      ]);
      if (done.error) throw toAppError(done.error);
      const payments = unwrap(pays) as { amount_paise: number; type: string }[];
      const rows = (unwrap(util) ?? []) as UtilisationRow[];
      const revenuePaise = payments.reduce((sum, p) => sum + (p.type === 'refund' ? -p.amount_paise : p.amount_paise), 0);
      const hoursRented = rows.reduce((s, r) => s + Number(r.hours_rented), 0);
      const hoursAvailable = rows.reduce((s, r) => s + Number(r.hours_available), 0);
      return {
        completed: done.count ?? 0,
        revenuePaise,
        utilisation: hoursAvailable > 0 ? hoursRented / hoursAvailable : null,
        hoursRented,
        hoursAvailable,
      };
    },
  });
}
