// Small display helpers shared by the bookings list, dashboard and print screens.
import { PACKAGE_LABELS } from '@shared/constants.ts';
import type { Booking, BookingWithRefs } from '@/types/db';

/** "12 hrs", "24 hrs" or "36 hrs (custom)". */
export function packageLabel(b: Pick<Booking, 'package' | 'custom_hours'>): string {
  if (b.package === 'custom') return `${b.custom_hours ?? '?'} hrs (custom)`;
  return PACKAGE_LABELS[b.package];
}

export const carName = (b: Pick<BookingWithRefs, 'car'>) => b.car?.display_name ?? 'Car not visible';

/** Shown when row-level security hides the customer (Staff, outside the booking day). */
export const HIDDEN_CUSTOMER = 'Visible on the day';

export const customerName = (b: Pick<BookingWithRefs, 'customer'>) => b.customer?.full_name ?? HIDDEN_CUSTOMER;
