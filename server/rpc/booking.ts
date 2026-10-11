// Booking logic (Sections 5.4, 6.4, 6.9, 6.10, 7, 8.3) — port of supabase/migrations/
// 20261011000300_booking_logic.sql on branch supabase-backend.
// CONTRACT STUB: the exported signatures below are used by other modules; implement them
// and register every RPC listed at the bottom with defineRpc().
import type { BookingPackage, BookingSource } from '../../shared/constants.ts';
import type { Ctx } from '../access/context.ts';

export interface ClashRow {
  kind: 'booking' | 'maintenance';
  ref_id: string;
  booking_code: string | null;
  status: string | null;
  starts_at: string;
  ends_at: string;
  note: string | null;
}

export interface Suggestion {
  id: string;
  slug: string;
  display_name: string;
  price_12h_paise: number;
  price_24h_paise: number;
}

export interface CreateBookingInput {
  carId: string;
  package: BookingPackage;
  /** ISO timestamp */
  pickupAt: string;
  customHours: number | null;
  fullName: string;
  phone: string;
  dlNumber: string;
  email: string | null;
  source: BookingSource;
  createdBy: string | null;
  noticeVersion: string;
  consentChannel: 'website' | 'admin';
  ip: string | null;
  userAgent: string | null;
  /** Website: refuse clashing requests and suggest other cars (BK-10). Staff: flag instead. */
  rejectOnClash: boolean;
  /** Staff-created (walk-in) bookings skip the notice period and time step. */
  staff: boolean;
  priceOverridePaise?: number | null;
  overrideReason?: string | null;
  adminNotes?: string;
  depositPaise?: number | null;
}

export type CreateBookingResult =
  | {
      ok: true;
      booking_id: string;
      booking_code: string;
      customer_id: string;
      price_paise: number;
      pickup_at: string;
      return_due_at: string;
      flags: string[];
      clashes: ClashRow[];
    }
  | { ok: false; error: 'clash'; message: string; suggestions: Suggestion[] };

/** _create_booking: validates, finds/creates the customer, inserts the booking + consent + event, queues the email. */
export function createBooking(_ctx: Ctx, _input: CreateBookingInput): CreateBookingResult {
  throw new Error('not implemented');
}

/** _car_clashes: confirmed/active bookings (incl. buffer, overdue holding) and maintenance overlapping [start, end + buffer). */
export function carClashes(_carId: string, _startIso: string, _endIso: string, _excludeBookingId: string | null): ClashRow[] {
  throw new Error('not implemented');
}

/*
RPCs to register (names and p_* args exactly as in the SQL version):
  public: public_busy_windows, lookup_booking
  user:   car_clashes, car_paper_problems, admin_create_booking, booking_transition,
          pickup_gate_problems, record_handover, update_booking, extend_booking,
          add_booking_charge, remove_booking_charge, record_payment, set_booking_hold,
          report_utilisation
*/
