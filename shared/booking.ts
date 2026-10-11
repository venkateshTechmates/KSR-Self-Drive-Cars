// Booking lifecycle (Section 7) and money rules. The database enforces the same
// transitions in `booking_transition()`; this copy drives which buttons the admin shows.
import type { AppRole, BookingPackage, BookingStatus, PaymentStatus } from './constants.ts';
import { PACKAGE_HOURS } from './constants.ts';
import type { BookingRules } from './settings.ts';
import { MS_HOUR, MS_MINUTE, toDate, type DateInput } from './time.ts';

export const BOOKING_CODE_RE = /^KSR-\d{6}-\d{3,}$/;

export interface PricedCar {
  price_12h_paise: number;
  price_24h_paise: number;
}

export function packageHours(pkg: BookingPackage, customHours?: number | null): number {
  if (pkg === 'custom') return Math.max(1, Math.round(customHours ?? 0));
  return PACKAGE_HOURS[pkg];
}

export function computeReturn(pickup: DateInput, pkg: BookingPackage, customHours?: number | null): Date {
  return new Date(toDate(pickup).getTime() + packageHours(pkg, customHours) * MS_HOUR);
}

export function packagePrice(car: PricedCar, pkg: '12h' | '24h'): number {
  return pkg === '12h' ? car.price_12h_paise : car.price_24h_paise;
}

/** Hourly rate for custom extensions: the setting, or the 24 hr price spread over 24 hours. */
export function extraHourRate(car: PricedCar, rules: Pick<BookingRules, 'extra_hour_rate_paise'>): number {
  return rules.extra_hour_rate_paise > 0 ? rules.extra_hour_rate_paise : Math.ceil(car.price_24h_paise / 24 / 100) * 100;
}

/** Price of extending an Active booking (BKA-09). */
export function extensionPrice(
  car: PricedCar,
  extension: { kind: '12h' | '24h' } | { kind: 'hours'; hours: number },
  rules: Pick<BookingRules, 'extra_hour_rate_paise'>,
): number {
  if (extension.kind === 'hours') return Math.max(0, Math.round(extension.hours)) * extraHourRate(car, rules);
  return packagePrice(car, extension.kind);
}

/** Whole late hours after the grace period (BKA-10). */
export function lateHours(returnDue: DateInput, actualReturn: DateInput, graceMinutes: number): number {
  const lateMs = toDate(actualReturn).getTime() - toDate(returnDue).getTime() - graceMinutes * MS_MINUTE;
  return lateMs > 0 ? Math.ceil(lateMs / MS_HOUR) : 0;
}

export function suggestedLateFee(hours: number, rules: Pick<BookingRules, 'late_fee_per_hour_paise'>): number {
  return hours * rules.late_fee_per_hour_paise;
}

export function isOverdue(b: { status: BookingStatus; return_due_at: string }, now: DateInput = new Date()): boolean {
  return b.status === 'active' && new Date(b.return_due_at).getTime() < toDate(now).getTime();
}

/** Status shown in the admin: "overdue" is not stored, it is derived (Section 7). */
export type DisplayStatus = BookingStatus | 'overdue';
export function displayStatus(b: { status: BookingStatus; return_due_at: string }, now?: DateInput): DisplayStatus {
  return isOverdue(b, now) ? 'overdue' : b.status;
}

// ---------------------------------------------------------------- transitions

export type TransitionAction =
  | 'confirm'
  | 'reject'
  | 'cancel'
  | 'no_show'
  | 'pickup'
  | 'return'
  | 'close';

export interface Transition {
  action: TransitionAction;
  to: BookingStatus;
  label: string;
  roles: readonly AppRole[];
  reasonRequired: boolean;
}

const OM: readonly AppRole[] = ['owner', 'manager'];
const ALL: readonly AppRole[] = ['owner', 'manager', 'staff'];

export const TRANSITIONS: Record<BookingStatus, readonly Transition[]> = {
  requested: [
    { action: 'confirm', to: 'confirmed', label: 'Confirm', roles: OM, reasonRequired: false },
    { action: 'reject', to: 'rejected', label: 'Reject', roles: OM, reasonRequired: true },
    { action: 'cancel', to: 'cancelled', label: 'Cancel', roles: OM, reasonRequired: true },
  ],
  confirmed: [
    { action: 'pickup', to: 'active', label: 'Mark picked up', roles: ALL, reasonRequired: false },
    { action: 'no_show', to: 'no_show', label: 'Mark no-show', roles: ALL, reasonRequired: false },
    { action: 'cancel', to: 'cancelled', label: 'Cancel', roles: OM, reasonRequired: true },
  ],
  active: [{ action: 'return', to: 'returned', label: 'Mark returned', roles: ALL, reasonRequired: false }],
  returned: [{ action: 'close', to: 'closed', label: 'Close', roles: OM, reasonRequired: false }],
  rejected: [],
  cancelled: [],
  no_show: [],
  closed: [],
};

export function allowedTransitions(from: BookingStatus, role: AppRole | null | undefined): Transition[] {
  if (!role) return [];
  return TRANSITIONS[from].filter((t) => t.roles.includes(role));
}

export function canTransition(from: BookingStatus, to: BookingStatus, role: AppRole): boolean {
  return TRANSITIONS[from].some((t) => t.to === to && t.roles.includes(role));
}

/** Bookings can be edited (car, package, time, price) only before pickup (BKA-05). */
export const isEditable = (status: BookingStatus) => status === 'requested' || status === 'confirmed';

// ---------------------------------------------------------------- payments

export interface Ledger {
  totalPaise: number;
  /** Rent and extra-charge payments, net of refunds. */
  paidPaise: number;
  refundedPaise: number;
}

export function paymentStatus({ totalPaise, paidPaise, refundedPaise }: Ledger): PaymentStatus {
  if (refundedPaise > 0 && paidPaise <= 0) return 'refunded';
  if (paidPaise <= 0) return 'unpaid';
  if (paidPaise >= totalPaise) return 'paid';
  return 'part_paid';
}

/** Total due = quoted price + extra charges − discount. */
export const bookingTotal = (b: { price_quoted_paise: number; extra_charges_paise: number; discount_paise: number }) =>
  b.price_quoted_paise + b.extra_charges_paise - b.discount_paise;
