// Validation rules from Appendix A and customer-facing messages from Section 5.4.
// Shared by the booking form (inline, on blur) and the submit-booking edge function
// (BK-06: every rule is repeated on the server).
import type { BookingRules, OpeningHours } from './settings.ts';
import { WEEKDAY_LABELS } from './settings.ts';
import {
  addDaysIso,
  formatClock,
  fromIst,
  isHHMM,
  isIsoDate,
  istDateIso,
  MS_HOUR,
  minutesOf,
  toDate,
  weekdayOf,
  type DateInput,
} from './time.ts';

export const MESSAGES = {
  pickupMissing: 'Choose a pickup date and time.',
  pickupPastDate: 'Choose today or a later date.',
  pickupTooFar: (days: number) => `You can book up to ${days} days ahead. Choose an earlier date.`,
  pickupClosed: (day: string) => `We're closed on ${day}s. Choose another day.`,
  pickupOutsideHours: (open: string, close: string) =>
    `We hand over cars between ${formatClock(open)} and ${formatClock(close)}. Choose a time in that window.`,
  pickupStep: (step: number) => `Choose a time on a ${step}-minute step, for example 9:00 or 9:30.`,
  pickupTooSoon: (hours: number) =>
    `Bookings need at least ${hours} hour${hours === 1 ? '' : 's'}' notice. For an earlier pickup, call us.`,
  nameRequired: 'Enter your full name.',
  nameInvalid: 'Use 2–80 letters. Spaces, full stops, apostrophes and hyphens are fine.',
  phoneRequired: 'Enter your mobile number.',
  phoneInvalid: 'Enter a 10-digit mobile number starting with 6, 7, 8 or 9.',
  dlRequired: 'Enter your driving licence number.',
  dlInvalid: 'Enter your driving licence number as printed, for example TS0920110012345.',
  dlOldFormat: "This doesn't look like the current licence format. That's fine: we'll check it at pickup.",
  emailInvalid: 'Enter a valid email address, or leave it blank.',
  aadhaarLast4Invalid: 'Enter only the last 4 digits of the Aadhaar number.',
  consentRequired: 'Tick the box to agree to how we use your details for this booking.',
  carRequired: 'Choose a car.',
  packageRequired: 'Choose a 12 hr or 24 hr package.',
  carClash: 'This car is booked at that time. Try another time or another car.',
  carUnavailable: 'This car is not available on this date. Try another date or another car.',
  tooManyRequests: 'Too many requests. Please call us.',
  network: "Couldn't send your request. Check your connection and try again.",
  success: (code: string, phone: string) => `Request sent. Your booking code is ${code}. We'll call you on ${phone} to confirm.`,
} as const;

// ---------------------------------------------------------------- mobile

/** Strip spaces, hyphens, brackets and a leading +91 / 91 / 0; return +91XXXXXXXXXX or null. */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  let digits = input.replace(/[\s\-().]/g, '');
  if (digits.startsWith('+91')) digits = digits.slice(3);
  else if (digits.startsWith('0091')) digits = digits.slice(4);
  else if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
}

export function validatePhone(input: string): string | null {
  if (!input.trim()) return MESSAGES.phoneRequired;
  return normalizePhone(input) ? null : MESSAGES.phoneInvalid;
}

/** "+91 98765 43210" for display. */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return '';
  const m = /^\+91(\d{5})(\d{5})$/.exec(e164);
  return m ? `+91 ${m[1]} ${m[2]}` : e164;
}

/** Digits for wa.me links, e.g. "919876543210". */
export const waDigits = (e164: string) => e164.replace(/\D/g, '');

// ---------------------------------------------------------------- name

const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u;

export const normalizeName = (input: string) => input.trim().replace(/\s+/g, ' ');

export function validateName(input: string): string | null {
  const name = normalizeName(input);
  if (!name) return MESSAGES.nameRequired;
  if ([...name].length < 2 || [...name].length > 80 || !NAME_RE.test(name)) return MESSAGES.nameInvalid;
  return null;
}

// ---------------------------------------------------------------- driving licence

/** State code, RTO code, year of issue (19xx/20xx), 7-digit number. */
export const DL_MODERN_RE = /^[A-Z]{2}\d{2}(19|20)\d{2}\d{7}$/;

export const normalizeDl = (input: string) => input.toUpperCase().replace(/[\s\-/]/g, '');

export interface DlCheck {
  value: string;
  error: string | null;
  /** True for older formats: accepted, but flagged for staff to check (Appendix A). */
  oldFormat: boolean;
}

export function checkDl(input: string): DlCheck {
  const value = normalizeDl(input);
  if (!value) return { value, error: MESSAGES.dlRequired, oldFormat: false };
  if (!/^[A-Z0-9]{6,20}$/.test(value)) return { value, error: MESSAGES.dlInvalid, oldFormat: false };
  return { value, error: null, oldFormat: !DL_MODERN_RE.test(value) };
}

// ---------------------------------------------------------------- email, aadhaar

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateEmail(input: string | null | undefined): string | null {
  const v = (input ?? '').trim();
  if (!v) return null;
  return EMAIL_RE.test(v) && v.length <= 254 ? null : MESSAGES.emailInvalid;
}

export function validateAadhaarLast4(input: string): string | null {
  return /^\d{4}$/.test(input.trim()) ? null : MESSAGES.aadhaarLast4Invalid;
}

/** A full Aadhaar number must never be accepted anywhere (AC-03). */
export const looksLikeFullAadhaar = (input: string) => /^\d{12}$/.test(input.replace(/[\s-]/g, ''));

// ---------------------------------------------------------------- pickup

export interface PickupContext {
  rules: Pick<BookingRules, 'min_lead_hours' | 'window_days' | 'time_step_minutes'>;
  hours: OpeningHours;
  now?: DateInput;
  /** Staff-created bookings (walk-ins) skip the notice period and the time step. */
  skipLeadTime?: boolean;
}

export function validatePickupDate(dateIso: string, ctx: PickupContext): string | null {
  if (!dateIso) return MESSAGES.pickupMissing;
  if (!isIsoDate(dateIso)) return MESSAGES.pickupMissing;
  const today = istDateIso(ctx.now ?? new Date());
  if (dateIso < today) return MESSAGES.pickupPastDate;
  if (dateIso > addDaysIso(today, ctx.rules.window_days)) return MESSAGES.pickupTooFar(ctx.rules.window_days);
  const day = ctx.hours[weekdayOf(dateIso)];
  if (day.closed) return MESSAGES.pickupClosed(WEEKDAY_LABELS[weekdayOf(dateIso)]);
  return null;
}

export function validatePickup(dateIso: string, time: string, ctx: PickupContext): string | null {
  if (!dateIso || !time) return MESSAGES.pickupMissing;
  const dateError = validatePickupDate(dateIso, ctx);
  if (dateError) return dateError;
  if (!isHHMM(time)) return MESSAGES.pickupMissing;
  const day = ctx.hours[weekdayOf(dateIso)];
  const t = minutesOf(time);
  if (t < minutesOf(day.open) || t > minutesOf(day.close)) return MESSAGES.pickupOutsideHours(day.open, day.close);
  if (!ctx.skipLeadTime) {
    const step = ctx.rules.time_step_minutes || 30;
    if (t % step !== 0) return MESSAGES.pickupStep(step);
    const at = fromIst(dateIso, time);
    const earliest = toDate(ctx.now ?? new Date()).getTime() + ctx.rules.min_lead_hours * MS_HOUR;
    if (!at || at.getTime() < earliest) return MESSAGES.pickupTooSoon(ctx.rules.min_lead_hours);
  }
  return null;
}

// ---------------------------------------------------------------- whole request

export interface BookingRequestInput {
  car_id: string;
  package: string;
  pickup_date: string;
  pickup_time: string;
  full_name: string;
  phone: string;
  dl_number: string;
  email?: string | null;
  consent: boolean;
  /** Hidden field; real people leave it empty. */
  website?: string | null;
}

export type BookingField =
  | 'car_id'
  | 'package'
  | 'pickup'
  | 'full_name'
  | 'phone'
  | 'dl_number'
  | 'email'
  | 'consent';

export interface NormalizedBookingRequest {
  car_id: string;
  package: '12h' | '24h';
  pickup_at: Date;
  full_name: string;
  phone: string;
  dl_number: string;
  dl_old_format: boolean;
  email: string | null;
}

export type BookingValidation =
  | { ok: true; value: NormalizedBookingRequest; errors: Record<string, never> }
  | { ok: false; errors: Partial<Record<BookingField, string>> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateBookingRequest(input: BookingRequestInput, ctx: PickupContext): BookingValidation {
  const errors: Partial<Record<BookingField, string>> = {};
  if (!input.car_id || !UUID_RE.test(input.car_id)) errors.car_id = MESSAGES.carRequired;
  if (input.package !== '12h' && input.package !== '24h') errors.package = MESSAGES.packageRequired;
  const pickupError = validatePickup(input.pickup_date, input.pickup_time, ctx);
  if (pickupError) errors.pickup = pickupError;
  const nameError = validateName(input.full_name ?? '');
  if (nameError) errors.full_name = nameError;
  const phoneError = validatePhone(input.phone ?? '');
  if (phoneError) errors.phone = phoneError;
  const dl = checkDl(input.dl_number ?? '');
  if (dl.error) errors.dl_number = dl.error;
  const emailError = validateEmail(input.email);
  if (emailError) errors.email = emailError;
  if (input.consent !== true) errors.consent = MESSAGES.consentRequired;

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors: {},
    value: {
      car_id: input.car_id,
      package: input.package as '12h' | '24h',
      pickup_at: fromIst(input.pickup_date, input.pickup_time)!,
      full_name: normalizeName(input.full_name),
      phone: normalizePhone(input.phone)!,
      dl_number: dl.value,
      dl_old_format: dl.oldFormat,
      email: input.email?.trim() ? input.email.trim().toLowerCase() : null,
    },
  };
}
