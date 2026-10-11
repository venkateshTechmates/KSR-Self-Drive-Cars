// Pure helpers for the booking detail screen.
import { lateHours, suggestedLateFee } from '@shared/booking.ts';
import { FUEL_LEVELS, PACKAGE_LABELS, type BookingStatus, type FuelLevel, type PaymentType } from '@shared/constants.ts';
import { formatPhone } from '@shared/validation.ts';
import type { BookingRules, BusinessSettings } from '@shared/settings.ts';
import { formatWhen } from '@/lib/format';
import type { Booking, BookingWithRefs, DocumentRow, HandoverRecord, ReturnSummary } from '@/types/db';

export const packageLabel = (b: Pick<Booking, 'package' | 'custom_hours'>) =>
  b.package === 'custom' ? `${b.custom_hours ?? '?'} hrs` : PACKAGE_LABELS[b.package];

/** Spoken names for the fuel symbols (¼, ½, ¾). */
export const FUEL_SPOKEN: Record<FuelLevel, string> = {
  empty: 'Empty',
  quarter: 'Quarter tank',
  half: 'Half tank',
  three_quarter: 'Three-quarter tank',
  full: 'Full tank',
};

const QUARTERS = ['', '¼ tank', '½ tank', '¾ tank', 'a full tank'];

/** "¼ tank less than at pickup", from the difference in quarters (return − pickup). */
export function fuelDiffLabel(quarters: number | null | undefined): string {
  if (quarters === null || quarters === undefined) return 'Not known';
  if (quarters === 0) return 'Same as at pickup';
  const n = Math.min(4, Math.abs(quarters));
  return `${QUARTERS[n]} ${quarters < 0 ? 'less' : 'more'} than at pickup`;
}

export const fuelIndex = (level: FuelLevel) => FUEL_LEVELS.indexOf(level);

export const PHOTO_SLOTS = [
  { key: 'front', label: 'Front' },
  { key: 'back', label: 'Back' },
  { key: 'left', label: 'Left side' },
  { key: 'right', label: 'Right side' },
  { key: 'interior', label: 'Interior' },
  { key: 'odometer', label: 'Odometer' },
  { key: 'fuel', label: 'Fuel gauge' },
] as const;
export type PhotoSlotKey = (typeof PHOTO_SLOTS)[number]['key'];

export const ACCESSORIES = [
  { key: 'spare_wheel', label: 'Spare wheel' },
  { key: 'jack', label: 'Jack and tools' },
  { key: 'documents_in_car', label: 'Car papers in the glovebox (RC, insurance, PUC)' },
] as const;
export type AccessoryKey = (typeof ACCESSORIES)[number]['key'];

/** What a pickup-gate problem (text from pickup_gate_problems) needs to fix it. */
export type GateFixKind = 'identity' | 'licence_renew' | 'licence';
export function gateFixFor(problem: string): GateFixKind {
  if (/identity/i.test(problem)) return 'identity';
  if (/expires on/i.test(problem)) return 'licence_renew';
  return 'licence';
}

/** Return figures without the RPC envelope. */
export type SettlementSummary = Omit<ReturnSummary, 'ok' | 'status'>;

/** HND-03 / BKA-10 figures worked out from the saved records, when the RPC result is not at hand. */
export function summaryFromRecords(
  booking: Booking,
  pickup: HandoverRecord | undefined,
  ret: HandoverRecord | undefined,
  rules: BookingRules,
): SettlementSummary {
  const km = pickup && ret ? ret.odometer_km - pickup.odometer_km : null;
  const fuel = pickup && ret ? fuelIndex(ret.fuel_level) - fuelIndex(pickup.fuel_level) : null;
  const late = booking.actual_return_at ? lateHours(booking.return_due_at, booking.actual_return_at, rules.late_grace_minutes) : 0;
  const limit = booking.package === '12h' ? rules.km_limit_12h : booking.package === '24h' ? rules.km_limit_24h : null;
  const extraKm = km !== null && limit !== null && limit !== undefined && km > limit ? km - limit : 0;
  return {
    km_driven: km,
    fuel_diff_quarters: fuel,
    late_hours: late,
    suggested_late_fee_paise: suggestedLateFee(late, rules),
    extra_km: extraKm,
    suggested_km_charge_paise: extraKm * (rules.extra_km_rate_paise ?? 0),
    deposit_held_paise: booking.deposit_received_paise - booking.deposit_refunded_paise,
  };
}

export interface Ledger {
  /** Total due minus rent/extra payments; negative when overpaid. */
  balance: number;
  unpaid: number;
  depositHeld: number;
  /** Deposit to give back once the unpaid balance is kept from it (HND-04). */
  refundDue: number;
  /** Still to collect after using the whole deposit. */
  shortfall: number;
}

export function ledgerOf(b: Booking): Ledger {
  const balance = b.total_paise - b.paid_paise;
  const unpaid = Math.max(0, balance);
  const depositHeld = b.deposit_received_paise - b.deposit_refunded_paise;
  return {
    balance,
    unpaid,
    depositHeld,
    refundDue: Math.max(0, depositHeld - unpaid),
    shortfall: Math.max(0, unpaid - Math.max(0, depositHeld)),
  };
}

/** Amount to suggest for a payment type (PAY-01). */
export function suggestedPayment(b: Booking, type: PaymentType): number {
  const l = ledgerOf(b);
  switch (type) {
    case 'rent':
    case 'extra':
      return l.unpaid;
    case 'deposit':
      return Math.max(0, b.deposit_paise - l.depositHeld);
    case 'refund':
      return Math.max(0, -l.balance);
    case 'deposit_refund':
      return Math.max(0, l.depositHeld);
  }
}

/** Values for SET-04 message templates. */
export function templateValues(b: BookingWithRefs, business: BusinessSettings): Record<string, string | null | undefined> {
  return {
    name: b.customer?.full_name,
    car: b.car?.display_name,
    package: packageLabel(b),
    pickup: formatWhen(b.pickup_at),
    return: formatWhen(b.return_due_at),
    code: b.booking_code,
    address: business.address,
    map: business.map_url,
    phone: formatPhone(business.phone) || business.phone,
    reason: b.cancel_reason,
  };
}

/** Parse a whole number of km; null if blank or invalid. */
export function parseKm(input: string): number | null {
  const v = input.replace(/[,\s]/g, '');
  if (!/^\d{1,7}$/.test(v)) return null;
  return Number(v);
}

/** The database accepts charges once a booking is confirmed; staff can't add to closed ones. */
export function canAddCharge(status: BookingStatus, om: boolean): boolean {
  if (status === 'requested' || status === 'rejected' || status === 'cancelled') return false;
  if (status === 'closed') return om;
  return true;
}

export type GateFix =
  | { kind: 'identity' }
  | { kind: 'verify_licence'; doc: DocumentRow }
  | { kind: 'upload_licence'; replaces: DocumentRow | null };

/** The fix for one gate problem, given the customer's current licence (front) document. */
export function fixFor(problem: string, licence: DocumentRow | undefined): GateFix | null {
  const kind = gateFixFor(problem);
  if (kind === 'identity') return { kind: 'identity' };
  if (kind === 'licence_renew') return { kind: 'upload_licence', replaces: licence ?? null };
  if (!licence) return { kind: 'upload_licence', replaces: null };
  if (licence.status === 'pending' || licence.status === 'verified') return { kind: 'verify_licence', doc: licence };
  return { kind: 'upload_licence', replaces: licence };
}
