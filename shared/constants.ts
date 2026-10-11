// Shared enums and labels. Imported by the web app (via the @shared alias) and by
// edge functions (Deno, relative imports), so this file must stay dependency-free.

export const APP_ROLES = ['owner', 'manager', 'staff'] as const;
export type AppRole = (typeof APP_ROLES)[number];
export const ROLE_LABELS: Record<AppRole, string> = { owner: 'Owner', manager: 'Manager', staff: 'Staff' };

export const BOOKING_STATUSES = [
  'requested',
  'confirmed',
  'rejected',
  'cancelled',
  'no_show',
  'active',
  'returned',
  'closed',
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];
export const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  requested: 'Requested',
  confirmed: 'Confirmed',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  no_show: 'No-show',
  active: 'Active',
  returned: 'Returned',
  closed: 'Closed',
};
/** Statuses that reserve the car (Section 7). */
export const HOLDING_STATUSES: readonly BookingStatus[] = ['confirmed', 'active'];
/** Statuses after which nothing more happens to the booking. */
export const TERMINAL_STATUSES: readonly BookingStatus[] = ['rejected', 'cancelled', 'no_show', 'closed'];

export const PACKAGES = ['12h', '24h', 'custom'] as const;
export type BookingPackage = (typeof PACKAGES)[number];
export const PACKAGE_LABELS: Record<BookingPackage, string> = { '12h': '12 hrs', '24h': '24 hrs', custom: 'Custom' };
export const PACKAGE_HOURS: Record<'12h' | '24h', number> = { '12h': 12, '24h': 24 };

export const BOOKING_SOURCES = ['website', 'phone', 'walk_in', 'whatsapp'] as const;
export type BookingSource = (typeof BOOKING_SOURCES)[number];
export const SOURCE_LABELS: Record<BookingSource, string> = {
  website: 'Website',
  phone: 'Phone',
  walk_in: 'Walk-in',
  whatsapp: 'WhatsApp',
};

export const BOOKING_FLAGS = ['clash', 'blocked_customer', 'dl_expiry', 'dl_format'] as const;
export type BookingFlag = (typeof BOOKING_FLAGS)[number];
export const FLAG_LABELS: Record<BookingFlag, string> = {
  clash: 'Clash',
  blocked_customer: 'Blocked customer',
  dl_expiry: 'Licence expiry',
  dl_format: 'Check licence format',
};

export const PAYMENT_STATUSES = ['unpaid', 'part_paid', 'paid', 'refunded'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  unpaid: 'Unpaid',
  part_paid: 'Part paid',
  paid: 'Paid',
  refunded: 'Refunded',
};

export const PAYMENT_TYPES = ['rent', 'deposit', 'extra', 'refund', 'deposit_refund'] as const;
export type PaymentType = (typeof PAYMENT_TYPES)[number];
export const PAYMENT_TYPE_LABELS: Record<PaymentType, string> = {
  rent: 'Rent',
  deposit: 'Deposit',
  extra: 'Extra charge',
  refund: 'Refund',
  deposit_refund: 'Deposit refund',
};
export const REFUND_TYPES: readonly PaymentType[] = ['refund', 'deposit_refund'];

export const PAYMENT_METHODS = ['cash', 'upi', 'card', 'bank'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  upi: 'UPI',
  card: 'Card',
  bank: 'Bank transfer',
};

export const CHARGE_KINDS = ['late', 'fuel', 'damage', 'cleaning', 'challan', 'extension', 'other'] as const;
export type ChargeKind = (typeof CHARGE_KINDS)[number];
export const CHARGE_KIND_LABELS: Record<ChargeKind, string> = {
  late: 'Late return',
  fuel: 'Fuel',
  damage: 'Damage',
  cleaning: 'Cleaning',
  challan: 'Challan / fine',
  extension: 'Extension',
  other: 'Other',
};

export const FUEL_LEVELS = ['empty', 'quarter', 'half', 'three_quarter', 'full'] as const;
export type FuelLevel = (typeof FUEL_LEVELS)[number];
export const FUEL_LEVEL_LABELS: Record<FuelLevel, string> = {
  empty: 'Empty',
  quarter: '¼',
  half: '½',
  three_quarter: '¾',
  full: 'Full',
};

export const BODY_TYPES = ['hatchback', 'compact_suv', 'crossover', 'suv', 'micro_suv', 'mpv', 'premium_mpv'] as const;
export type BodyType = (typeof BODY_TYPES)[number];
export const BODY_TYPE_LABELS: Record<BodyType, string> = {
  hatchback: 'Hatchback',
  compact_suv: 'Compact SUV',
  crossover: 'Crossover',
  suv: 'SUV',
  micro_suv: 'Micro SUV',
  mpv: 'MPV',
  premium_mpv: 'Premium MPV',
};

export const CAR_CATEGORIES = ['hatch', 'suv', 'mpv'] as const;
export type CarCategory = (typeof CAR_CATEGORIES)[number];
export const CATEGORY_LABELS: Record<CarCategory, string> = {
  hatch: 'Hatchbacks',
  suv: 'SUVs & crossovers',
  mpv: '6–7 seaters',
};
/** The category a body type belongs to, used as the default when adding a car. */
export const BODY_TYPE_CATEGORY: Record<BodyType, CarCategory> = {
  hatchback: 'hatch',
  compact_suv: 'suv',
  crossover: 'suv',
  suv: 'suv',
  micro_suv: 'suv',
  mpv: 'mpv',
  premium_mpv: 'mpv',
};

export const FUEL_TYPES = ['petrol', 'diesel', 'cng', 'electric'] as const;
export type FuelType = (typeof FUEL_TYPES)[number];
export const FUEL_LABELS: Record<FuelType, string> = { petrol: 'Petrol', diesel: 'Diesel', cng: 'CNG', electric: 'Electric' };

export const TRANSMISSIONS = ['manual', 'automatic'] as const;
export type Transmission = (typeof TRANSMISSIONS)[number];
export const TRANSMISSION_LABELS: Record<Transmission, string> = { manual: 'Manual', automatic: 'Automatic' };

export const CAR_STATUSES = ['active', 'inactive'] as const;
export type CarStatus = (typeof CAR_STATUSES)[number];

export const BADGE_PRESETS = ['Premium', 'New model', 'Best value', '7 seater'] as const;

export const MAINTENANCE_REASONS = ['service', 'repair', 'accident', 'other'] as const;
export type MaintenanceReason = (typeof MAINTENANCE_REASONS)[number];
export const MAINTENANCE_REASON_LABELS: Record<MaintenanceReason, string> = {
  service: 'Service',
  repair: 'Repair',
  accident: 'Accident',
  other: 'Other',
};

export const IDENTITY_METHODS = [
  'aadhaar_qr',
  'aadhaar_original_seen',
  'passport',
  'voter_id',
  'other',
  'digilocker',
] as const;
export type IdentityMethod = (typeof IDENTITY_METHODS)[number];
export const IDENTITY_METHOD_LABELS: Record<IdentityMethod, string> = {
  aadhaar_qr: 'Aadhaar secure QR scanned (UIDAI app)',
  aadhaar_original_seen: 'Original Aadhaar seen',
  passport: 'Passport',
  voter_id: 'Voter ID',
  other: 'Other government photo ID',
  digilocker: 'DigiLocker',
};

export const DOC_OWNER_TYPES = ['customer', 'booking', 'car', 'business'] as const;
export type DocOwnerType = (typeof DOC_OWNER_TYPES)[number];
export const DOC_OWNER_LABELS: Record<DocOwnerType, string> = {
  customer: 'Customer',
  booking: 'Booking',
  car: 'Vehicle',
  business: 'Business',
};

export const DOC_STATUSES = ['pending', 'verified', 'rejected', 'expired', 'superseded'] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];
export const DOC_STATUS_LABELS: Record<DocStatus, string> = {
  pending: 'Pending',
  verified: 'Verified',
  rejected: 'Rejected',
  expired: 'Expired',
  superseded: 'Superseded',
};

export const VERIFICATION_METHODS = ['original_seen', 'qr_scan', 'online_portal'] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];
export const VERIFICATION_METHOD_LABELS: Record<VerificationMethod, string> = {
  original_seen: 'Original seen at counter',
  qr_scan: 'QR code scanned',
  online_portal: 'Checked on official portal',
};

export const POLICY_KINDS = ['privacy', 'terms', 'cancellation'] as const;
export type PolicyKind = (typeof POLICY_KINDS)[number];
export const POLICY_LABELS: Record<PolicyKind, string> = {
  privacy: 'Privacy notice',
  terms: 'Terms of rental',
  cancellation: 'Cancellation policy',
};
export const POLICY_PATHS: Record<PolicyKind, string> = {
  privacy: '/privacy',
  terms: '/terms',
  cancellation: '/cancellation',
};

export const LOCALES = ['en', 'te', 'hi'] as const;
export type Locale = (typeof LOCALES)[number];
export const LOCALE_LABELS: Record<Locale, string> = { en: 'English', te: 'తెలుగు', hi: 'हिन्दी' };

export const DATA_REQUEST_KINDS = ['access', 'correction', 'erasure', 'grievance', 'consent_withdrawal'] as const;
export type DataRequestKind = (typeof DATA_REQUEST_KINDS)[number];
export const DATA_REQUEST_LABELS: Record<DataRequestKind, string> = {
  access: 'Access a copy',
  correction: 'Correction',
  erasure: 'Erasure',
  grievance: 'Grievance',
  consent_withdrawal: 'Withdraw consent',
};
