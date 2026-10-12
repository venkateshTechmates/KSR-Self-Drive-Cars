// Data the screens read, with TanStack Query (same queries as the website).
import { useQuery } from '@tanstack/react-query';
import { withDefaults, type BookingRules, type BusinessSettings } from '@shared/settings.ts';
import { addDaysIso, istDateIso, istStartOfDay } from '@shared/time.ts';
import { eq, gte, isIn, lt, notIn, rpc, select } from './api';
import type { Booking, BusyWindow, Payment, PublicCar } from './types';

export const BOOKING_SELECT =
  '*, car:cars(id, display_name, registration_number), customer:customers(id, full_name, phone)';

// ------------------------------------------------------------------ public

export function useCars() {
  return useQuery({
    queryKey: ['public', 'cars'],
    queryFn: () => select<PublicCar>('public_cars', { order: [{ column: 'sort_order' }, { column: 'display_name' }] }),
    staleTime: 5 * 60_000,
  });
}

export interface PublicConfig {
  business: BusinessSettings;
  rules: BookingRules;
}

export function usePublicConfig() {
  return useQuery({
    queryKey: ['public', 'settings'],
    queryFn: async (): Promise<PublicConfig> => {
      const rows = await select<{ key: string; value: unknown }>('public_settings', { select: 'key, value' });
      const get = (k: string) => rows.find((r) => r.key === k)?.value;
      return { business: withDefaults('business', get('business')), rules: withDefaults('booking_rules', get('booking_rules')) };
    },
    staleTime: 5 * 60_000,
  });
}

/** Cars booked or in maintenance (no personal data), for the "Booked at this time" hint. */
export function useBusyWindows(fromIso: string | null, toIso: string | null) {
  return useQuery({
    queryKey: ['public', 'busy', fromIso, toIso],
    enabled: Boolean(fromIso && toIso),
    queryFn: () => rpc<BusyWindow[]>('public_busy_windows', { p_from: fromIso, p_to: toIso }),
    staleTime: 60_000,
  });
}

// ------------------------------------------------------------------ staff

const bookings = (opts: Parameters<typeof select>[1]) => select<Booking>('bookings', { select: BOOKING_SELECT, ...opts });

export function useDashboard(enabled: boolean, showRequests: boolean) {
  return useQuery({
    queryKey: ['staff', 'dashboard', showRequests],
    enabled,
    refetchInterval: 120_000,
    queryFn: async () => {
      const today = istDateIso();
      const start = istStartOfDay(today).toISOString();
      const end = istStartOfDay(addDaysIso(today, 1)).toISOString();
      const [requested, pickups, returns, active] = await Promise.all([
        showRequests ? bookings({ filters: [eq('status', 'requested')], order: [{ column: 'created_at' }], limit: 50 }) : Promise.resolve([]),
        bookings({ filters: [gte('pickup_at', start), lt('pickup_at', end), notIn('status', ['rejected', 'cancelled'])], order: [{ column: 'pickup_at' }] }),
        bookings({ filters: [gte('return_due_at', start), lt('return_due_at', end), isIn('status', ['confirmed', 'active', 'returned', 'closed'])], order: [{ column: 'return_due_at' }] }),
        bookings({ filters: [eq('status', 'active')], order: [{ column: 'return_due_at' }] }),
      ]);
      const now = Date.now();
      return { requested, pickups, returns, overdue: active.filter((b) => Date.parse(b.return_due_at) < now) };
    },
  });
}

/** Recent bookings (newest pickup first); the list screen searches them on the phone. */
export function useRecentBookings(enabled: boolean) {
  return useQuery({
    queryKey: ['staff', 'bookings'],
    enabled,
    queryFn: () => bookings({ order: [{ column: 'pickup_at', ascending: false }], limit: 300 }),
  });
}

export function useBooking(code: string | undefined) {
  return useQuery({
    queryKey: ['staff', 'booking', code],
    enabled: Boolean(code),
    queryFn: async () => (await bookings({ filters: [eq('booking_code', code)], limit: 1 }))[0] ?? null,
  });
}

export function usePayments(bookingId: string | undefined) {
  return useQuery({
    queryKey: ['staff', 'payments', bookingId],
    enabled: Boolean(bookingId),
    queryFn: () => select<Payment>('payments', { filters: [eq('booking_id', bookingId)], order: [{ column: 'received_at' }] }),
  });
}
