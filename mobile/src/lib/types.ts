// Shapes of the server's data the app uses (a subset of src/types/db.ts on the website).
import type {
  AppRole,
  BodyType,
  BookingFlag,
  BookingPackage,
  BookingSource,
  BookingStatus,
  CarCategory,
  FuelType,
  PaymentMethod,
  PaymentStatus,
  PaymentType,
  Transmission,
} from '@shared/constants.ts';

export interface PublicCar {
  id: string;
  slug: string;
  display_name: string;
  body_type: BodyType;
  category: CarCategory;
  seats: number;
  fuel: FuelType;
  transmission: Transmission;
  badge: string | null;
  description: string;
  price_12h_paise: number;
  price_24h_paise: number;
  sort_order: number;
  photos: Array<{ id: string; path: string; alt: string; width: number; height: number }>;
}

export interface BusyWindow {
  car_id: string;
  starts_at: string;
  ends_at: string;
  kind: 'booking' | 'maintenance';
}

export interface Suggestion {
  id: string;
  slug: string;
  display_name: string;
  price_12h_paise: number;
  price_24h_paise: number;
}

export type SubmitResponse =
  | { ok: true; booking_code: string }
  | { ok: false; error: 'clash'; message: string; suggestions: Suggestion[] };

export interface LookupResult {
  found: boolean;
  code?: string;
  status?: string;
  car?: string;
  package?: string;
  pickup_at?: string;
  return_due_at?: string;
}

export interface Access {
  user_id: string | null;
  role: AppRole | null;
  effective_role: AppRole | null;
  mfa_required: boolean;
  aal: 'aal1' | 'aal2';
  full_name: string | null;
  active: boolean;
}

export interface Session {
  user: { id: string; email: string };
  aal: 'aal1' | 'aal2';
  mfa_enrolled: boolean;
  access: Access;
}

export interface Booking {
  id: string;
  booking_code: string;
  status: BookingStatus;
  source: BookingSource;
  package: BookingPackage;
  custom_hours: number | null;
  pickup_at: string;
  return_due_at: string;
  price_quoted_paise: number;
  extra_charges_paise: number;
  discount_paise: number;
  total_paise: number;
  paid_paise: number;
  deposit_paise: number;
  deposit_received_paise: number;
  deposit_refunded_paise: number;
  payment_status: PaymentStatus;
  flags: BookingFlag[];
  admin_notes: string;
  cancel_reason: string | null;
  created_at: string;
  car: { id: string; display_name: string; registration_number: string | null } | null;
  customer: { id: string; full_name: string; phone: string } | null;
}

export interface Payment {
  id: string;
  amount_paise: number;
  type: PaymentType;
  method: PaymentMethod;
  reference: string | null;
  note: string;
  received_at: string;
}
