import { useQuery } from '@tanstack/react-query';
import { api } from '@/integrations/api/client';
import { unwrap } from '@/lib/errors';
import type { BookingWithRefs } from '@/types/db';
import { qk } from './queries';

/**
 * Columns for booking lists and details. The customer join is null when row-level security
 * hides the customer (Staff, for bookings that are not today).
 */
export const BOOKING_SELECT =
  '*, car:cars(id, display_name, registration_number, category, body_type, slug), customer:customers(id, full_name, phone, blocked, identity_verified)';

export function useBookingByCode(code: string | undefined) {
  return useQuery({
    queryKey: qk.booking(code ?? ''),
    enabled: Boolean(code),
    queryFn: async () =>
      unwrap(await api.from('bookings').select(BOOKING_SELECT).eq('booking_code', code!).maybeSingle()) as BookingWithRefs | null,
  });
}
