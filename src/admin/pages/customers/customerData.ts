// Queries for one customer's record, bookings, payments and consents (CUS-03).
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { unwrap } from '@/lib/errors';
import type { Booking, Car, Consent, Customer, Payment } from '@/types/db';
import { qk } from '../../hooks/queries';
import { inChunks } from './customerSearch';

export type CustomerBooking = Booking & { car: Pick<Car, 'id' | 'display_name' | 'registration_number'> | null };

export function useCustomer(id: string | undefined) {
  return useQuery({
    queryKey: qk.customer(id ?? ''),
    enabled: Boolean(id),
    queryFn: async () => unwrap(await supabase.from('customers').select('*').eq('id', id!).maybeSingle()) as Customer | null,
  });
}

export function useCustomerBookings(id: string | undefined) {
  return useQuery({
    queryKey: [...qk.bookings, 'customer', id ?? ''],
    enabled: Boolean(id),
    queryFn: async () =>
      (unwrap(
        await supabase
          .from('bookings')
          .select('*, car:cars(id, display_name, registration_number)')
          .eq('customer_id', id!)
          .order('pickup_at', { ascending: false }),
      ) ?? []) as CustomerBooking[],
  });
}

export function useCustomerPayments(id: string | undefined, bookingIds: string[]) {
  return useQuery({
    queryKey: [...qk.payments, 'customer', id ?? '', bookingIds],
    enabled: Boolean(id) && bookingIds.length > 0,
    queryFn: async () => {
      const rows = await inChunks(
        bookingIds,
        async (chunk) => (unwrap(await supabase.from('payments').select('*').in('booking_id', chunk)) ?? []) as Payment[],
      );
      return rows.sort((a, b) => b.received_at.localeCompare(a.received_at));
    },
  });
}

export function useCustomerConsents(id: string | undefined) {
  return useQuery({
    queryKey: [...qk.customer(id ?? ''), 'consents'],
    enabled: Boolean(id),
    queryFn: async () =>
      (unwrap(await supabase.from('consents').select('*').eq('customer_id', id!).order('granted_at', { ascending: false })) ??
        []) as Consent[],
  });
}

/** Number of bookings per customer, for the merge comparison. */
export function useBookingCounts(ids: string[]) {
  return useQuery({
    queryKey: [...qk.bookings, 'counts', ids],
    enabled: ids.length > 0,
    queryFn: async () => {
      const rows = (unwrap(await supabase.from('bookings').select('customer_id').in('customer_id', ids)) ?? []) as Array<{ customer_id: string }>;
      const counts = new Map<string, number>();
      for (const r of rows) counts.set(r.customer_id, (counts.get(r.customer_id) ?? 0) + 1);
      return counts;
    },
  });
}

export const CONSENT_PURPOSE_LABELS: Record<Consent['purpose'], string> = {
  booking: 'Booking',
  aadhaar_verification: 'Aadhaar verification',
  document_upload: 'Document upload',
};

export const CONSENT_CHANNEL_LABELS: Record<Consent['channel'], string> = {
  website: 'Website',
  admin: 'At the counter',
  customer_link: 'Upload link',
};
