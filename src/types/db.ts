// Row types for the tables and views in supabase/migrations. Keep in step with the SQL.
import type {
  AppRole,
  BodyType,
  BookingPackage,
  BookingSource,
  BookingStatus,
  CarCategory,
  CarStatus,
  ChargeKind,
  DataRequestKind,
  DocOwnerType,
  DocStatus,
  FuelLevel,
  FuelType,
  IdentityMethod,
  MaintenanceReason,
  PaymentMethod,
  PaymentStatus,
  PaymentType,
  PolicyKind,
  Transmission,
  VerificationMethod,
  BookingFlag,
} from '@shared/constants.ts';

type Timestamps = { created_at: string; updated_at: string };

export interface Car extends Timestamps {
  id: string;
  slug: string;
  display_name: string;
  brand: string;
  model: string;
  variant: string;
  body_type: BodyType;
  category: CarCategory;
  seats: number;
  fuel: FuelType;
  transmission: Transmission;
  colour: string;
  year: number | null;
  registration_number: string | null;
  badge: string | null;
  description: string;
  price_12h_paise: number;
  price_24h_paise: number;
  status: CarStatus;
  sort_order: number;
  cover_photo_id: string | null;
}

export interface CarPhoto extends Timestamps {
  id: string;
  car_id: string;
  storage_path: string;
  alt_text: string;
  sort_order: number;
  width: number;
  height: number;
  created_by: string | null;
}

export interface CarPriceHistory extends Timestamps {
  id: string;
  car_id: string;
  price_12h_paise: number;
  price_24h_paise: number;
  changed_by: string | null;
  changed_at: string;
}

export interface MaintenanceWindow extends Timestamps {
  id: string;
  car_id: string;
  starts_at: string;
  ends_at: string;
  reason: MaintenanceReason;
  notes: string;
  created_by: string | null;
}

export interface ServiceLog extends Timestamps {
  id: string;
  car_id: string;
  service_date: string;
  odometer_km: number | null;
  work_done: string;
  cost_paise: number;
  garage: string;
  invoice_document_id: string | null;
  created_by: string | null;
}

export interface Customer extends Timestamps {
  id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  dl_number: string | null;
  dl_expiry: string | null;
  aadhaar_last4: string | null;
  identity_verified: boolean;
  identity_method: IdentityMethod | null;
  identity_verified_by: string | null;
  identity_verified_at: string | null;
  blocked: boolean;
  block_reason: string | null;
  notes: string;
  erased_at: string | null;
}

export interface Booking extends Timestamps {
  id: string;
  booking_code: string;
  customer_id: string;
  car_id: string;
  package: BookingPackage;
  custom_hours: number | null;
  pickup_at: string;
  return_due_at: string;
  hold_until: string;
  buffer_minutes: number;
  actual_pickup_at: string | null;
  actual_return_at: string | null;
  status: BookingStatus;
  source: BookingSource;
  price_quoted_paise: number;
  extra_charges_paise: number;
  discount_paise: number;
  deposit_paise: number;
  deposit_received_paise: number;
  deposit_refunded_paise: number;
  total_paise: number;
  paid_paise: number;
  refunded_paise: number;
  payment_status: PaymentStatus;
  flags: BookingFlag[];
  cancel_reason: string | null;
  admin_notes: string;
  on_hold: boolean;
  hold_reason: string | null;
  created_by: string | null;
  consent_id: string | null;
  ended_at: string | null;
  overdue_notified_at: string | null;
}

/** Booking with the joins most screens need. Customer is null when RLS hides it (staff, not today). */
export interface BookingWithRefs extends Booking {
  car: Pick<Car, 'id' | 'display_name' | 'registration_number' | 'category' | 'body_type' | 'slug'> | null;
  customer: Pick<Customer, 'id' | 'full_name' | 'phone' | 'blocked' | 'identity_verified'> | null;
}

export interface BookingEvent extends Timestamps {
  id: string;
  booking_id: string;
  kind: 'status' | 'edit' | 'handover' | 'payment' | 'charge' | 'note' | 'override';
  from_status: BookingStatus | null;
  to_status: BookingStatus | null;
  actor_id: string | null;
  note: string | null;
  at: string;
}

export interface HandoverRecord extends Timestamps {
  id: string;
  booking_id: string;
  kind: 'pickup' | 'return';
  odometer_km: number;
  fuel_level: FuelLevel;
  checklist: HandoverChecklist;
  damage_notes: string;
  signature_document_id: string | null;
  recorded_by: string | null;
  recorded_at: string;
}

export interface HandoverChecklist {
  licence_checked?: boolean;
  identity_checked?: boolean;
  photos?: { front?: boolean; back?: boolean; left?: boolean; right?: boolean; interior?: boolean; odometer?: boolean; fuel?: boolean };
  accessories?: { spare_wheel?: boolean; jack?: boolean; documents_in_car?: boolean; [key: string]: boolean | undefined };
  deposit_collected_paise?: number;
  terms_accepted?: boolean;
  [key: string]: unknown;
}

export interface BookingCharge extends Timestamps {
  id: string;
  booking_id: string;
  kind: ChargeKind;
  amount_paise: number;
  note: string;
  document_id: string | null;
  added_by: string | null;
}

export interface Payment extends Timestamps {
  id: string;
  booking_id: string;
  amount_paise: number;
  type: PaymentType;
  method: PaymentMethod;
  reference: string | null;
  note: string;
  receipt_document_id: string | null;
  received_by: string | null;
  received_at: string;
}

export interface DocumentType extends Timestamps {
  id: string;
  key: string;
  label: string;
  owner_type: DocOwnerType;
  is_kyc: boolean;
  tracks_expiry: boolean;
  expiry_required: boolean;
  blocks_booking_when_expired: boolean;
  required_for_pickup: boolean;
  view_roles: AppRole[];
  download_roles: AppRole[];
  retention_days: number | null;
  retention_basis: 'none' | 'booking_end' | 'customer_last_booking_end';
  sort_order: number;
  active: boolean;
}

export interface DocumentRow extends Timestamps {
  id: string;
  owner_type: DocOwnerType;
  customer_id: string | null;
  booking_id: string | null;
  car_id: string | null;
  owner_id: string | null;
  doc_type: string;
  storage_path: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  doc_number_masked: string | null;
  issue_date: string | null;
  expiry_date: string | null;
  notes: string;
  status: DocStatus;
  verification_method: VerificationMethod | null;
  verified_by: string | null;
  verified_at: string | null;
  reject_reason: string | null;
  version: number;
  replaces_id: string | null;
  aadhaar_masked_confirmed: boolean;
  uploaded_by: string | null;
  uploaded_via: 'admin' | 'customer_link';
  upload_link_id: string | null;
  legal_hold: boolean;
  hold_reason: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  delete_reason: string | null;
  retain_until: string | null;
}

export interface Consent extends Timestamps {
  id: string;
  customer_id: string;
  booking_id: string | null;
  purpose: 'booking' | 'aadhaar_verification' | 'document_upload';
  notice_version: string;
  channel: 'website' | 'admin' | 'customer_link';
  granted_at: string;
  ip: string | null;
  user_agent: string | null;
  recorded_by: string | null;
  withdrawn_at: string | null;
}

export interface StaffProfile extends Timestamps {
  user_id: string;
  full_name: string;
  email: string;
  phone: string | null;
  active: boolean;
  last_seen_at: string | null;
}

export interface UserRole extends Timestamps {
  id: string;
  user_id: string;
  role: AppRole;
}

export interface SettingRow extends Timestamps {
  id: string;
  key: string;
  value: unknown;
  updated_by: string | null;
}

export interface PolicyVersion extends Timestamps {
  id: string;
  kind: PolicyKind;
  locale: string;
  version: number;
  title: string;
  body_md: string;
  published_at: string;
  published_by: string | null;
}

export interface AuditLog extends Timestamps {
  id: string;
  actor_id: string | null;
  actor_role: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip: string | null;
  user_agent: string | null;
  at: string;
}

export interface DataRequest extends Timestamps {
  id: string;
  customer_id: string | null;
  requester_name: string;
  requester_contact: string;
  kind: DataRequestKind;
  details: string;
  status: 'open' | 'in_progress' | 'done' | 'refused';
  received_at: string;
  due_at: string | null;
  resolved_at: string | null;
  resolution: string | null;
  handled_by: string | null;
  created_by: string | null;
}

export interface UploadLink extends Timestamps {
  id: string;
  customer_id: string;
  booking_id: string | null;
  expires_at: string;
  used_at: string | null;
  created_by: string | null;
}

// ------------------------------------------------------------------ public views

export interface PublicCarPhoto {
  id: string;
  path: string;
  alt: string;
  width: number;
  height: number;
}

export interface PublicCar {
  id: string;
  slug: string;
  display_name: string;
  brand: string;
  model: string;
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
  photos: PublicCarPhoto[];
}

export interface PublicPolicy {
  kind: PolicyKind;
  locale: string;
  version: number;
  title: string;
  body_md: string;
  published_at: string;
  label: string;
}

// ------------------------------------------------------------------ RPC results

export interface MyAccess {
  user_id: string | null;
  role: AppRole | null;
  effective_role: AppRole | null;
  mfa_required: boolean;
  aal: 'aal1' | 'aal2';
  full_name: string | null;
  active: boolean;
  security: Record<string, unknown>;
}

export interface Clash {
  kind: 'booking' | 'maintenance';
  ref_id: string;
  booking_code: string | null;
  status: BookingStatus | null;
  starts_at: string;
  ends_at: string;
  note: string | null;
}

export interface PaperProblem {
  doc_type: string;
  label: string;
  expiry_date: string | null;
  problem: 'missing' | 'expired';
}

export interface ReturnSummary {
  ok: true;
  status: 'returned';
  km_driven: number | null;
  fuel_diff_quarters: number | null;
  late_hours: number;
  suggested_late_fee_paise: number;
  extra_km: number;
  suggested_km_charge_paise: number;
  deposit_held_paise: number;
}

export interface UtilisationRow {
  car_id: string;
  display_name: string;
  hours_available: number;
  hours_rented: number;
  utilisation: number;
}
