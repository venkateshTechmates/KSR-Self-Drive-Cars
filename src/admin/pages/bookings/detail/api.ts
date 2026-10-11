// Data for the booking detail screen (BKA-03). Every key sits under qk.bookings (or
// qk.customers), so invalidating that prefix after a mutation refreshes the whole screen.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { unwrap } from '@/lib/errors';
import type { BookingCharge, BookingEvent, Clash, Customer, HandoverRecord, PaperProblem, Payment } from '@/types/db';
import { qk } from '@/admin/hooks/queries';

/** Call an RPC and return its data, throwing an AppError (with .code and .hint) on failure. */
export async function rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
  return unwrap(await supabase.rpc(fn, args)) as T;
}

export const detailKeys = {
  events: (bookingId: string) => [...qk.bookings, 'events', bookingId] as const,
  handovers: (bookingId: string) => [...qk.bookings, 'handovers', bookingId] as const,
  charges: (bookingId: string) => [...qk.bookings, 'charges', bookingId] as const,
  payments: (bookingId: string) => [...qk.bookings, 'payments', bookingId] as const,
  gate: (bookingId: string) => [...qk.bookings, 'gate', bookingId] as const,
  clashes: (carId: string, start: string, end: string, exclude: string) => [...qk.bookings, 'clashes', carId, start, end, exclude] as const,
  papers: (carId: string, until: string) => [...qk.bookings, 'papers', carId, until] as const,
  customer: (customerId: string) => [...qk.customer(customerId), 'booking-detail'] as const,
};

export function useBookingEvents(bookingId: string) {
  return useQuery({
    queryKey: detailKeys.events(bookingId),
    queryFn: async () =>
      unwrap(
        await supabase
          .from('booking_events')
          .select('*')
          .eq('booking_id', bookingId)
          .order('at', { ascending: false })
          .order('created_at', { ascending: false }),
      ) as BookingEvent[],
  });
}

export function useHandovers(bookingId: string) {
  return useQuery({
    queryKey: detailKeys.handovers(bookingId),
    queryFn: async () =>
      unwrap(await supabase.from('handover_records').select('*').eq('booking_id', bookingId).order('recorded_at')) as HandoverRecord[],
  });
}

export function useCharges(bookingId: string) {
  return useQuery({
    queryKey: detailKeys.charges(bookingId),
    queryFn: async () =>
      unwrap(await supabase.from('booking_charges').select('*').eq('booking_id', bookingId).order('created_at')) as BookingCharge[],
  });
}

export function usePayments(bookingId: string) {
  return useQuery({
    queryKey: detailKeys.payments(bookingId),
    queryFn: async () =>
      unwrap(
        await supabase
          .from('payments')
          .select('*')
          .eq('booking_id', bookingId)
          .order('received_at', { ascending: false })
          .order('created_at', { ascending: false }),
      ) as Payment[],
  });
}

/** DOC-09 / AC-09: what still blocks handing over the car. */
export function useGateProblems(bookingId: string, enabled: boolean) {
  return useQuery({
    queryKey: detailKeys.gate(bookingId),
    enabled,
    queryFn: async () => (await rpc<string[] | null>('pickup_gate_problems', { p_booking: bookingId })) ?? [],
  });
}

export type CustomerDetail = Pick<
  Customer,
  | 'id'
  | 'full_name'
  | 'phone'
  | 'email'
  | 'blocked'
  | 'block_reason'
  | 'identity_verified'
  | 'identity_method'
  | 'identity_verified_by'
  | 'identity_verified_at'
  | 'dl_number'
  | 'dl_expiry'
  | 'erased_at'
>;

const CUSTOMER_COLUMNS =
  'id, full_name, phone, email, blocked, block_reason, identity_verified, identity_method, identity_verified_by, identity_verified_at, dl_number, dl_expiry, erased_at';

/** Fuller customer row than the booking join. Null when row-level security hides it (Staff, not today). */
export function useCustomerDetail(customerId: string | null) {
  return useQuery({
    queryKey: detailKeys.customer(customerId ?? ''),
    enabled: Boolean(customerId),
    queryFn: async () =>
      unwrap(await supabase.from('customers').select(CUSTOMER_COLUMNS).eq('id', customerId!).maybeSingle()) as CustomerDetail | null,
  });
}

/** Bookings and maintenance that overlap a period on a car (BKA-05, BKA-09). */
export function useCarClashes(carId: string | null, start: Date | null, end: Date | null, excludeBookingId: string) {
  const s = start?.toISOString() ?? '';
  const e = end?.toISOString() ?? '';
  return useQuery({
    queryKey: detailKeys.clashes(carId ?? '', s, e, excludeBookingId),
    enabled: Boolean(carId && s && e),
    queryFn: async () => (await rpc<Clash[] | null>('car_clashes', { p_car: carId, p_start: s, p_end: e, p_exclude: excludeBookingId })) ?? [],
    staleTime: 15_000,
  });
}

/** Insurance, PUC or permit missing or expiring before the return time (FLT-08). Owner/Manager only. */
export function useCarPaperProblems(carId: string | null, until: Date | null, enabled: boolean) {
  const u = until?.toISOString() ?? '';
  return useQuery({
    queryKey: detailKeys.papers(carId ?? '', u),
    enabled: enabled && Boolean(carId && u),
    queryFn: async () => (await rpc<PaperProblem[] | null>('car_paper_problems', { p_car: carId, p_until: u })) ?? [],
    staleTime: 60_000,
  });
}

type ExtraKey = 'documents' | 'payments' | 'customers';

/** Refresh everything on the screen after a mutation (plus related areas). */
export function useRefresh() {
  const queryClient = useQueryClient();
  return (...extra: ExtraKey[]) =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.bookings }),
      queryClient.invalidateQueries({ queryKey: qk.dashboard }),
      ...extra.map((k) => queryClient.invalidateQueries({ queryKey: qk[k] })),
    ]);
}
