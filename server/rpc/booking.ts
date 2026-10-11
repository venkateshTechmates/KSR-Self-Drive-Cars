// Booking logic (Sections 5.4, 6.4, 6.9, 6.10, 7, 8.3) — port of supabase/migrations/
// 20261011000300_booking_logic.sql on branch supabase-backend.
// Errors keep the SQL shape: message = text for people, detail = machine code, hint = optional JSON.
// The HTTP route runs every RPC inside one tx(), so each handler is synchronous and atomic:
// any error rolls back everything the call wrote.
import type { BookingRules } from '../../shared/settings.ts';
import type {
  AppRole,
  BookingFlag,
  BookingPackage,
  BookingSource,
  BookingStatus,
  ChargeKind,
  FuelLevel,
  PaymentMethod,
  PaymentType,
} from '../../shared/constants.ts';
import type { Booking, BookingCharge, BookingEvent, Car, Customer, PaperProblem, UtilisationRow } from '../../src/types/db.ts';
import { extraHourRate, paymentStatus } from '../../shared/booking.ts';
import {
  BOOKING_SOURCES,
  BOOKING_STATUSES,
  CHARGE_KINDS,
  FUEL_LEVELS,
  HOLDING_STATUSES,
  PACKAGES,
  PAYMENT_METHODS,
  PAYMENT_TYPES,
  TERMINAL_STATUSES,
} from '../../shared/constants.ts';
import { formatRupees } from '../../shared/money.ts';
import { WEEKDAY_LABELS, WEEKDAYS } from '../../shared/settings.ts';
import { addDaysIso, formatClock, formatIsoDate, formatWhen, istDateIso, istParts, minutesOf, MS_HOUR, MS_MINUTE } from '../../shared/time.ts';
import { DL_MODERN_RE, normalizeDl, normalizeName, normalizePhone } from '../../shared/validation.ts';
import { isAdmin, isOwnerOrManager, type Ctx } from '../access/context.ts';
import { canSeeBooking } from '../access/scope.ts';
import { writeAudit } from '../audit.ts';
import { config } from '../config.ts';
import { all, nowIso, one } from '../db/connection.ts';
import { deleteRow, getRow, insertRow, updateRow } from '../db/write.ts';
import { fail, forbidden } from '../errors.ts';
import { enqueueEmail, recipients } from '../outbox.ts';
import { ipHash, registerAttempt } from '../ratelimit.ts';
import { bookingRule, currentNoticeVersion, getSetting } from '../settings.ts';
import { bool, int, json, oneOf, str, ts } from './args.ts';
import { defineRpc } from './registry.ts';

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

// ------------------------------------------------------------------ small helpers
/** my_role(). Trusted jobs (ctx.system) bypass role checks, so they act with Owner rights. */
const roleOf = (ctx: Ctx): AppRole | null => (ctx.system ? 'owner' : ctx.role);

/** booking_rule(name, default)::integer */
const ruleInt = (name: keyof BookingRules, fallback: number): number => Math.round(bookingRule(name, fallback));

/** Turnaround buffer between rentals (never negative). */
const bufferMinutes = (): number => Math.max(0, ruleInt('turnaround_buffer_minutes', 60));

const plusMinutes = (iso: string, minutes: number): string => new Date(Date.parse(iso) + minutes * MS_MINUTE).toISOString();
const plusHours = (iso: string, hours: number): string => new Date(Date.parse(iso) + hours * MS_HOUR).toISOString();
const laterOf = (a: string, b: string): string => (a > b ? a : b);
const earlierOf = (a: string, b: string): string => (a < b ? a : b);

/** Trimmed text, or null when blank: nullif(trim(coalesce(x, '')), ''). */
const clean = (v: string | null | undefined): string | null => v?.trim() || null;

/** to_char(date, 'DD Mon YYYY'): "05 Oct 2026" (the override note keeps the leading zero). */
const ddMonYyyy = (dateIso: string): string => formatIsoDate(dateIso).replace(/^(\d) /, '0$1 ');

const packageLabel = (pkg: BookingPackage, hours: number | null): string =>
  pkg === '12h' ? '12 hrs' : pkg === '24h' ? '24 hrs' : `${hours} hrs`;

function bookingNotFound(): never {
  return fail('Booking not found.', 'not_found', undefined, 404);
}

/** A booking the caller may act on: Staff only within their window (staff_can_see_booking). */
function loadVisibleBooking(ctx: Ctx, bookingId: string | null): Booking {
  const b = bookingId ? getRow<Booking>('bookings', bookingId) : undefined;
  if (!b || !canSeeBooking(ctx, b.id)) bookingNotFound();
  return b;
}

/**
 * The SQL functions caught exclusion_violation from the bookings_no_overlap constraint. In
 * SQLite the overlap triggers raise "bookings_no_overlap: …" instead; give the same answer.
 */
function guardOverlap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof Error && err.message.includes('bookings_no_overlap')) fail('This car is already booked at that time.', 'clash');
    throw err;
  }
}

function addEvent(
  ctx: Ctx,
  bookingId: string,
  kind: BookingEvent['kind'],
  note: string | null,
  opts: { from?: BookingStatus | null; to?: BookingStatus | null; actorId?: string | null } = {},
): void {
  insertRow(ctx, 'booking_events', {
    booking_id: bookingId,
    kind,
    from_status: opts.from ?? null,
    to_status: opts.to ?? null,
    actor_id: opts.actorId !== undefined ? opts.actorId : ctx.userId,
    note,
  });
}

// ------------------------------------------------------------------ booking code KSR-YYMMDD-NNN
function nextBookingCode(): string {
  const day = istDateIso();
  const n = one<{ last: number }>(
    `INSERT INTO booking_code_counters (day, last) VALUES (?, 1)
     ON CONFLICT (day) DO UPDATE SET last = last + 1
     RETURNING last`,
    day,
  )!.last;
  return `KSR-${day.slice(2, 4)}${day.slice(5, 7)}${day.slice(8, 10)}-${String(n).padStart(3, '0')}`;
}

// ------------------------------------------------------------------ derived booking fields
type BookingValues = Partial<Booking> & Pick<Booking, 'status' | 'return_due_at' | 'price_quoted_paise'>;

/**
 * Port of the bookings_derive trigger; applied to every booking insert and update below.
 * The turnaround buffer is captured when the booking starts holding the car (insert, entering
 * Confirmed/Active, or a new return time); hold_until, total and payment status follow.
 */
function deriveBooking(row: BookingValues, before: Booking | null): Partial<Booking> {
  let buffer = row.buffer_minutes ?? 0;
  if (
    !before ||
    (HOLDING_STATUSES.includes(row.status) && !HOLDING_STATUSES.includes(before.status)) ||
    row.return_due_at !== before.return_due_at
  ) {
    buffer = bufferMinutes();
  }
  const total = row.price_quoted_paise + (row.extra_charges_paise ?? 0) - (row.discount_paise ?? 0);
  const out: Partial<Booking> = {
    buffer_minutes: buffer,
    hold_until: plusMinutes(row.return_due_at, buffer),
    total_paise: total,
    payment_status: paymentStatus({ totalPaise: total, paidPaise: row.paid_paise ?? 0, refundedPaise: row.refunded_paise ?? 0 }),
  };
  if (TERMINAL_STATUSES.includes(row.status) && (!before || before.status !== row.status)) out.ended_at = nowIso();
  return out;
}

function insertBooking(ctx: Ctx, values: BookingValues): Booking {
  return insertRow<Booking>(ctx, 'bookings', { ...values, ...deriveBooking(values, null) });
}

/** Update a booking (audited) with its derived fields kept in step. */
export function saveBooking(ctx: Ctx, before: Booking, patch: Partial<Booking>): Booking {
  const derived = deriveBooking({ ...before, ...patch }, before);
  return updateRow<Booking>(ctx, 'bookings', before.id, { ...patch, ...derived })!;
}

// ------------------------------------------------------------------ availability
/** _car_clashes: confirmed/active bookings (incl. buffer, overdue holding) and maintenance overlapping [start, end + buffer). */
export function carClashes(carId: string, startIso: string, endIso: string, excludeBookingId: string | null): ClashRow[] {
  const buffer = bufferMinutes();
  const start = new Date(startIso).toISOString();
  const wantEnd = plusMinutes(new Date(endIso).toISOString(), buffer);
  if (start >= wantEnd) return []; // an empty range overlaps nothing
  // An overdue Active booking holds the car until it returns (at least now + buffer).
  const activeUntil = plusMinutes(nowIso(), buffer);

  const bookings = all<{ id: string; booking_code: string; status: string; pickup_at: string; hold_until: string }>(
    `SELECT id, booking_code, status, pickup_at, hold_until
       FROM bookings
      WHERE car_id = ? AND status IN ('confirmed', 'active') AND (? IS NULL OR id <> ?)`,
    carId,
    excludeBookingId,
    excludeBookingId,
  );
  const out: ClashRow[] = [];
  for (const b of bookings) {
    const endsAt = b.status === 'active' ? laterOf(b.hold_until, activeUntil) : b.hold_until;
    if (b.pickup_at < wantEnd && start < endsAt) {
      out.push({ kind: 'booking', ref_id: b.id, booking_code: b.booking_code, status: b.status, starts_at: b.pickup_at, ends_at: endsAt, note: null });
    }
  }
  const maintenance = all<{ id: string; starts_at: string; ends_at: string; reason: string; notes: string }>(
    'SELECT id, starts_at, ends_at, reason, notes FROM maintenance_windows WHERE car_id = ? AND starts_at < ? AND ? < ends_at',
    carId,
    wantEnd,
    start,
  );
  for (const m of maintenance) {
    out.push({
      kind: 'maintenance',
      ref_id: m.id,
      booking_code: null,
      status: null,
      starts_at: m.starts_at,
      ends_at: m.ends_at,
      note: m.notes ? `${m.reason}: ${m.notes}` : m.reason,
    });
  }
  return out.sort((a, b) => (a.starts_at < b.starts_at ? -1 : a.starts_at > b.starts_at ? 1 : 0));
}

/** _suggest_cars: up to N active cars of the same category that are free for the period (BK-10). */
function suggestCars(carId: string, startIso: string, endIso: string, limit = 3): Suggestion[] {
  const orig = one<{ category: string; price_12h_paise: number }>('SELECT category, price_12h_paise FROM cars WHERE id = ?', carId);
  if (!orig) return [];
  const candidates = all<Suggestion>(
    `SELECT id, slug, display_name, price_12h_paise, price_24h_paise
       FROM cars
      WHERE status = 'active' AND id <> ? AND category = ?
      ORDER BY abs(price_12h_paise - ?), sort_order`,
    carId,
    orig.category,
    orig.price_12h_paise,
  );
  const out: Suggestion[] = [];
  for (const c of candidates) {
    if (out.length >= limit) break;
    if (carClashes(c.id, startIso, endIso, null).length === 0) out.push({ ...c });
  }
  return out;
}

/** public_busy_windows: busy windows per active car for at most 4 days, without any personal data (FLE-05). */
function publicBusyWindows(fromIso: string | null, toIso: string | null) {
  // tstzrange(p_from, least(p_to, p_from + 4 days)): a missing bound is unbounded.
  const lower = fromIso;
  const fourDays = fromIso ? new Date(Date.parse(fromIso) + 4 * 24 * MS_HOUR).toISOString() : null;
  const upper = toIso && fourDays ? earlierOf(toIso, fourDays) : (toIso ?? fourDays);
  if (lower && upper && lower >= upper) return [];
  const overlaps = (s: string, e: string) => (upper === null || s < upper) && (lower === null || lower < e);
  const now = nowIso();

  const out: Array<{ car_id: string; starts_at: string; ends_at: string; kind: 'booking' | 'maintenance' }> = [];
  const bookings = all<{ car_id: string; status: string; pickup_at: string; hold_until: string }>(
    `SELECT b.car_id, b.status, b.pickup_at, b.hold_until
       FROM bookings b JOIN cars c ON c.id = b.car_id AND c.status = 'active'
      WHERE b.status IN ('confirmed', 'active')`,
  );
  for (const b of bookings) {
    const endsAt = b.status === 'active' ? laterOf(b.hold_until, now) : b.hold_until;
    if (overlaps(b.pickup_at, endsAt)) out.push({ car_id: b.car_id, starts_at: b.pickup_at, ends_at: endsAt, kind: 'booking' });
  }
  const maintenance = all<{ car_id: string; starts_at: string; ends_at: string }>(
    `SELECT m.car_id, m.starts_at, m.ends_at
       FROM maintenance_windows m JOIN cars c ON c.id = m.car_id AND c.status = 'active'`,
  );
  for (const m of maintenance) {
    if (overlaps(m.starts_at, m.ends_at)) out.push({ car_id: m.car_id, starts_at: m.starts_at, ends_at: m.ends_at, kind: 'maintenance' });
  }
  return out;
}

// ------------------------------------------------------------------ vehicle papers (FLT-08)
/** _car_paper_problems: blocking paper types (insurance, PUC, permit) that are missing, or expire before `until`. */
function carPaperProblems(carId: string, untilIso: string): PaperProblem[] {
  const untilDay = istDateIso(untilIso);
  const types = all<{ key: string; label: string }>(
    `SELECT key, label FROM document_types
      WHERE owner_type = 'car' AND blocks_booking_when_expired = 1 AND active = 1
      ORDER BY sort_order`,
  );
  const out: PaperProblem[] = [];
  for (const t of types) {
    // The current version of this paper.
    const cur = one<{ id: string; expiry_date: string | null }>(
      `SELECT id, expiry_date FROM documents
        WHERE car_id = ? AND doc_type = ? AND deleted_at IS NULL AND status NOT IN ('superseded', 'rejected')
        ORDER BY version DESC, created_at DESC
        LIMIT 1`,
      carId,
      t.key,
    );
    if (!cur) out.push({ doc_type: t.key, label: t.label, expiry_date: null, problem: 'missing' });
    else if (cur.expiry_date !== null && cur.expiry_date < untilDay) {
      out.push({ doc_type: t.key, label: t.label, expiry_date: cur.expiry_date, problem: 'expired' });
    }
  }
  return out;
}

// ------------------------------------------------------------------ pickup rules (Appendix A)
/** _validate_pickup. Returns the pickup time (ISO) when it passes. */
function validatePickup(pickupAt: string | null, staff: boolean): string {
  if (!pickupAt) return fail('Choose a pickup date and time.', 'pickup');
  const date = istDateIso(pickupAt);
  const today = istDateIso();
  const p = istParts(pickupAt);
  const weekday = WEEKDAYS[p.weekday];
  const hours = getSetting('business').hours[weekday];
  const minutes = p.hour * 60 + p.minute;
  const step = Math.max(5, ruleInt('time_step_minutes', 30));
  const lead = bookingRule('min_lead_hours', 2);
  const windowDays = ruleInt('window_days', 60);

  if (date < today) fail('Choose today or a later date.', 'pickup');
  if (date > addDaysIso(today, windowDays)) fail(`You can book up to ${windowDays} days ahead. Choose an earlier date.`, 'pickup');
  if (hours) {
    if (hours.closed) fail(`We're closed on ${WEEKDAY_LABELS[weekday]}s. Choose another day.`, 'pickup');
    if (minutes < minutesOf(hours.open) || minutes > minutesOf(hours.close)) {
      fail(`We hand over cars between ${formatClock(hours.open)} and ${formatClock(hours.close)}. Choose a time in that window.`, 'pickup');
    }
  }
  // Staff-created bookings (walk-ins) skip the notice period and time step.
  if (!staff) {
    if (minutes % step !== 0) fail(`Choose a time on a ${step}-minute step, for example 9:00 or 9:30.`, 'pickup');
    if (Date.parse(pickupAt) < Date.now() + lead * MS_HOUR) {
      // rtrim(to_char(v_lead, 'FM999990.##'), '.'): "2", "1.5"
      fail(`Bookings need at least ${String(Number(lead.toFixed(2)))} hours' notice. For an earlier pickup, call us.`, 'pickup');
    }
  }
  return pickupAt;
}

// ------------------------------------------------------------------ create a booking (BK-09, BKA-06)
// Characters a name may not contain (Appendix A).
const NAME_FORBIDDEN_RE = /[0-9<>@#$%^&*()_+=[\]{}|\\/:;",?!~`]/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** _create_booking: validates, finds/creates the customer, inserts the booking + consent + event, queues the email. */
export function createBooking(ctx: Ctx, input: CreateBookingInput): CreateBookingResult {
  const car = input.carId ? getRow<Car>('cars', input.carId) : undefined;
  const phone = normalizePhone(input.phone);
  const dl = normalizeDl(input.dlNumber ?? '') || null;
  const name = normalizeName(input.fullName ?? '');
  const email = clean(input.email)?.toLowerCase() ?? null;
  const nameLength = [...name].length;
  let notes = input.adminNotes ?? '';

  if (!car || car.status !== 'active') return fail('Choose a car.', 'car_id');
  if (!phone) return fail('Enter a 10-digit mobile number starting with 6, 7, 8 or 9.', 'phone');
  if (nameLength < 2 || nameLength > 80 || NAME_FORBIDDEN_RE.test(name)) {
    fail('Use 2–80 letters. Spaces, full stops, apostrophes and hyphens are fine.', 'full_name');
  }
  if (!dl || !/^[A-Z0-9]{6,20}$/.test(dl)) return fail('Enter your driving licence number as printed, for example TS0920110012345.', 'dl_number');
  if (email !== null && !EMAIL_RE.test(email)) fail('Enter a valid email address, or leave it blank.', 'email');

  const pickupMs = Date.parse(input.pickupAt ?? '');
  const pickupAt = validatePickup(Number.isNaN(pickupMs) ? null : new Date(pickupMs).toISOString(), input.staff);

  const pkg = input.package;
  const hours = pkg === '12h' ? 12 : pkg === '24h' ? 24 : input.customHours;
  if (hours === null || hours === undefined || hours < 1) return fail('Choose a 12 hr or 24 hr package.', 'package');
  const returnAt = plusHours(pickupAt, hours);

  // Price snapshot (8.3): the price shown now is stored and never changes with car prices.
  let price: number | null = pkg === '12h' ? car.price_12h_paise : pkg === '24h' ? car.price_24h_paise : null;
  const override = input.priceOverridePaise ?? null;
  if (override !== null && override !== price) {
    if (!input.staff) forbidden();
    if (!clean(input.overrideReason) && price !== null) fail('A price override needs a reason.', 'price_reason');
    price = override;
  }
  if (price === null || price < 0) return fail('Enter a price for a custom package.', 'price');

  const clashes = carClashes(car.id, pickupAt, returnAt, null);
  const flags: BookingFlag[] = [];
  if (clashes.length > 0) {
    if (input.rejectOnClash) {
      // Public response: no booking codes or times, just alternatives.
      return {
        ok: false,
        error: 'clash',
        message: 'This car is booked at that time. Try another time or another car.',
        suggestions: suggestCars(car.id, pickupAt, returnAt, 3),
      };
    }
    flags.push('clash');
  }

  // One customer per mobile number (CUS-01). A repeat customer keeps a verified name and the
  // licence number on file; a different licence number is noted on the booking.
  let customer: Customer;
  const existingId = one<{ id: string }>('SELECT id FROM customers WHERE phone = ?', phone)?.id;
  if (!existingId) {
    customer = insertRow<Customer>(ctx, 'customers', { full_name: name, phone, email, dl_number: dl });
  } else {
    const existing = getRow<Customer>('customers', existingId)!;
    customer = updateRow<Customer>(ctx, 'customers', existingId, {
      full_name: existing.identity_verified ? existing.full_name : name,
      email: email ?? existing.email,
      dl_number: existing.dl_number ?? dl,
    })!;
    if (customer.dl_number !== dl) {
      notes = [notes || null, `Licence number given for this booking: ${dl} (differs from the one on file).`].filter(Boolean).join('\n');
    }
  }

  if (customer.blocked) flags.push('blocked_customer');
  if (customer.dl_expiry !== null && customer.dl_expiry < istDateIso(returnAt)) flags.push('dl_expiry');
  if (!DL_MODERN_RE.test(dl)) flags.push('dl_format');

  let booking = insertBooking(ctx, {
    booking_code: nextBookingCode(),
    customer_id: customer.id,
    car_id: car.id,
    package: pkg,
    custom_hours: pkg === 'custom' ? hours : null,
    pickup_at: pickupAt,
    return_due_at: returnAt,
    hold_until: returnAt,
    status: 'requested',
    source: input.source,
    price_quoted_paise: price,
    flags,
    admin_notes: notes,
    created_by: input.createdBy,
    deposit_paise: input.depositPaise ?? ruleInt('default_deposit_paise', 0),
  });

  const consent = insertRow<{ id: string }>(ctx, 'consents', {
    customer_id: customer.id,
    booking_id: booking.id,
    purpose: 'booking',
    notice_version: input.noticeVersion,
    channel: input.consentChannel,
    ip: input.ip,
    user_agent: input.userAgent?.slice(0, 400) ?? null,
    recorded_by: input.createdBy,
  });
  booking = saveBooking(ctx, booking, { consent_id: consent.id });

  const overrideNote =
    input.priceOverridePaise !== null && input.priceOverridePaise !== undefined && clean(input.overrideReason)
      ? `. Price set to ${formatRupees(price)}: ${input.overrideReason}`
      : '';
  addEvent(
    ctx,
    booking.id,
    'status',
    (input.source === 'website' ? 'Request sent from the website' : `Created by staff (${input.source.replace(/_/g, '-')})`) + overrideNote,
    { from: null, to: 'requested', actorId: input.createdBy },
  );

  // New request alert (Section 11). Flagged requests also go to the flagged list.
  const to = [...recipients('new_request_emails'), ...(flags.length > 0 ? recipients('flagged_emails') : [])];
  const body = [
    `New booking request ${booking.booking_code}`,
    '',
    `Car: ${car.display_name}`,
    `Package: ${packageLabel(pkg, hours)}`,
    `Pickup: ${formatWhen(booking.pickup_at)}`,
    `Return by: ${formatWhen(booking.return_due_at)}`,
    `Price: ${formatRupees(price)}`,
    `Customer: ${customer.full_name}, ${customer.phone}`,
    `Source: ${input.source}`,
    flags.length > 0 ? `Flags: ${flags.join(', ')}` : null,
  ]
    .filter((line) => line !== null)
    .join('\n');
  enqueueEmail('new_request', to, `New booking request ${booking.booking_code} – ${car.display_name}`, body, {
    booking_code: booking.booking_code,
    path: `/admin/bookings/${booking.booking_code}`,
  });

  return {
    ok: true,
    booking_id: booking.id,
    booking_code: booking.booking_code,
    customer_id: customer.id,
    price_paise: price,
    pickup_at: booking.pickup_at,
    return_due_at: booking.return_due_at,
    flags,
    clashes,
  };
}

// ------------------------------------------------------------------ status transitions (Section 7)
function clashMessage(c: ClashRow): string {
  return c.kind === 'booking'
    ? `This car is already booked: ${c.booking_code} (${formatWhen(c.starts_at)} – ${formatWhen(c.ends_at)}).`
    : `This car is in maintenance from ${formatWhen(c.starts_at)} to ${formatWhen(c.ends_at)}.`;
}

function bookingTransition(ctx: Ctx, bookingId: string | null, to: BookingStatus, noteIn: string | null, overrideIn: string | null) {
  const role = roleOf(ctx);
  if (!role) forbidden();
  const b = loadVisibleBooking(ctx, bookingId);
  const note = clean(noteIn);
  const reason = clean(overrideIn);
  const overrides: string[] = [];
  const ownerOrManager = role === 'owner' || role === 'manager';

  if (to === 'active' || to === 'returned') fail('Use the handover checklist to record pickup and return.', 'use_handover');

  const allowed =
    (b.status === 'requested' && (to === 'confirmed' || to === 'rejected' || to === 'cancelled') && ownerOrManager) ||
    (b.status === 'confirmed' && to === 'cancelled' && ownerOrManager) ||
    (b.status === 'confirmed' && to === 'no_show') ||
    (b.status === 'returned' && to === 'closed' && ownerOrManager);
  if (!allowed) fail(`This booking can't move from ${b.status} to ${to}.`, 'state');

  if ((to === 'rejected' || to === 'cancelled') && note === null) fail('Give a reason.', 'reason');

  if (to === 'confirmed') {
    if (one<{ status: string }>('SELECT status FROM cars WHERE id = ?', b.car_id)?.status !== 'active') {
      fail('This car is inactive. Make it active or move the booking to another car.', 'car_inactive');
    }
    // BKA-07: refuse clashes and show the clashing booking.
    const clash = carClashes(b.car_id, b.pickup_at, b.return_due_at, b.id)[0];
    if (clash) {
      fail(clashMessage(clash), 'clash', {
        kind: clash.kind,
        id: clash.ref_id,
        code: clash.booking_code,
        starts_at: clash.starts_at,
        ends_at: clash.ends_at,
      });
    }
    // FLT-08: expired insurance / PUC / permit blocks confirmation unless the Owner overrides.
    for (const problem of carPaperProblems(b.car_id, b.return_due_at).filter((p) => p.problem === 'expired')) {
      const expiry = problem.expiry_date!;
      if (role === 'owner' && reason !== null) {
        overrides.push(`${problem.label} expired ${ddMonYyyy(expiry)}`);
      } else {
        fail(
          `${problem.label} for this car expires on ${formatIsoDate(expiry)}, before the return time. The Owner can override with a reason.`,
          'papers_expired',
          { doc_type: problem.doc_type, expiry_date: expiry },
        );
      }
    }
  }

  if (to === 'no_show' && nowIso() < b.pickup_at) fail('You can mark a no-show only after the pickup time.', 'state');

  if (to === 'closed') {
    const balance = b.total_paise - b.paid_paise;
    const deposit = b.deposit_received_paise - b.deposit_refunded_paise;
    if (balance !== 0 || deposit !== 0) {
      if (reason === null) {
        fail(
          `Settle the booking first: balance ${formatRupees(balance)}, deposit held ${formatRupees(deposit)}. To close anyway, give a reason.`,
          'unsettled',
        );
      }
      overrides.push(`Closed with balance ${formatRupees(balance)} and deposit held ${formatRupees(deposit)}`);
    }
  }

  saveBooking(ctx, b, { status: to, cancel_reason: to === 'rejected' || to === 'cancelled' ? note : b.cancel_reason });
  addEvent(ctx, b.id, 'status', note, { from: b.status, to });

  if (overrides.length > 0) {
    addEvent(ctx, b.id, 'override', `${overrides.join('; ')}. Reason: ${reason}`);
    writeAudit(ctx, 'booking.override', 'bookings', b.id, null, { to, overrides, reason });
  }

  return { ok: true, status: to };
}

// ------------------------------------------------------------------ pickup gate (DOC-09, AC-09)
// The booking page picks a fix button from these messages ("identity" → verify identity,
// "expires on" → renew licence, otherwise verify/upload licence). Keep those words if you
// reword them (src/admin/pages/bookings/detail/helpers.ts).
function pickupGateProblems(b: Booking): string[] {
  const c = getRow<Customer>('customers', b.customer_id)!;
  const problems: string[] = [];
  const licence = one<{ n: number; expiry: string | null }>(
    `SELECT count(*) AS n, max(expiry_date) AS expiry FROM documents
      WHERE customer_id = ? AND doc_type = 'dl_front' AND status = 'verified' AND deleted_at IS NULL`,
    c.id,
  )!;
  if (licence.n === 0) problems.push('Verify the driving licence (front photo) first.');
  const expiry = licence.expiry ?? c.dl_expiry;
  if (expiry === null) problems.push('Record the licence expiry date when verifying the licence.');
  else if (expiry < istDateIso(b.return_due_at)) {
    problems.push(`The driving licence expires on ${formatIsoDate(expiry)}, before the return time.`);
  }
  if (!c.identity_verified) problems.push("Verify the customer's identity (Aadhaar QR, passport or voter ID).");
  return problems;
}

// ------------------------------------------------------------------ handover and return (HND-01..04)
interface HandoverInput {
  bookingId: string | null;
  kind: 'pickup' | 'return';
  odometerKm: number | null;
  fuelLevel: FuelLevel | null;
  checklist: unknown;
  damageNotes: string | null;
  signatureDocumentId: string | null;
  overrideReason: string | null;
}

function recordHandover(ctx: Ctx, input: HandoverInput) {
  const role = roleOf(ctx);
  if (!role) forbidden();
  const b = loadVisibleBooking(ctx, input.bookingId);
  const reason = clean(input.overrideReason);
  const now = nowIso();
  const km = input.odometerKm;
  if (km === null || km < 0) return fail('Enter the odometer reading in km.', 'odometer_km');
  if (
    input.signatureDocumentId !== null &&
    !one('SELECT 1 FROM documents WHERE id = ? AND booking_id = ?', input.signatureDocumentId, b.id)
  ) {
    fail('The signature must be saved to this booking.', 'invalid');
  }
  const fuelWords = (input.fuelLevel ?? '').replace(/_/g, ' ');
  const record = (kind: 'pickup' | 'return') =>
    insertRow(ctx, 'handover_records', {
      booking_id: b.id,
      kind,
      odometer_km: km,
      fuel_level: input.fuelLevel,
      checklist: input.checklist ?? {},
      damage_notes: input.damageNotes ?? '',
      signature_document_id: input.signatureDocumentId,
      recorded_by: ctx.userId,
      recorded_at: now,
    });

  if (input.kind === 'pickup') {
    if (b.status !== 'confirmed') fail('Only a Confirmed booking can be handed over.', 'state');
    const problems = pickupGateProblems(b);
    if (problems.length > 0) {
      if (role === 'owner' && reason !== null) {
        addEvent(ctx, b.id, 'override', `Pickup checks overridden (${problems.join(' ')}). Reason: ${reason}`);
        writeAudit(ctx, 'booking.override', 'bookings', b.id, null, { to: 'active', problems, reason });
      } else {
        fail(problems.join(' '), 'pickup_gate', problems);
      }
    }
    record('pickup');
    saveBooking(ctx, b, { status: 'active', actual_pickup_at: now });
    addEvent(ctx, b.id, 'status', `Picked up. Odometer ${km} km, fuel ${fuelWords}.`, { from: 'confirmed', to: 'active' });
    return { ok: true, status: 'active' };
  }

  // Return
  if (b.status !== 'active') fail('Only an Active booking can be returned.', 'state');
  const pickup = one<{ odometer_km: number; fuel_level: FuelLevel }>(
    "SELECT odometer_km, fuel_level FROM handover_records WHERE booking_id = ? AND kind = 'pickup'",
    b.id,
  );
  if (pickup && km < pickup.odometer_km) {
    fail(`The odometer reading is lower than at pickup (${pickup.odometer_km} km).`, 'odometer_km');
  }
  record('return');
  saveBooking(ctx, b, { status: 'returned', actual_return_at: now });

  const grace = ruleInt('late_grace_minutes', 30);
  const lateMs = Date.parse(now) - Date.parse(b.return_due_at) - grace * MS_MINUTE;
  const lateHours = lateMs > 0 ? Math.ceil(lateMs / MS_HOUR) : 0;
  let kmDriven: number | null = null;
  let fuelDiff: number | null = null;
  let extraKm = 0;
  if (pickup) {
    kmDriven = km - pickup.odometer_km;
    fuelDiff = FUEL_LEVELS.indexOf(input.fuelLevel!) - FUEL_LEVELS.indexOf(pickup.fuel_level);
    const rules = getSetting('booking_rules');
    const limit = b.package === '12h' ? rules.km_limit_12h : b.package === '24h' ? rules.km_limit_24h : null;
    if (typeof limit === 'number' && kmDriven > limit) extraKm = kmDriven - limit;
  }

  addEvent(
    ctx,
    b.id,
    'status',
    `Returned. Odometer ${km} km${kmDriven !== null ? ` (${kmDriven} km driven)` : ''}, fuel ${fuelWords}` +
      `${lateHours > 0 ? `, ${lateHours} h late` : ''}.`,
    { from: 'active', to: 'returned' },
  );

  return {
    ok: true,
    status: 'returned',
    km_driven: kmDriven,
    fuel_diff_quarters: fuelDiff,
    late_hours: lateHours,
    suggested_late_fee_paise: lateHours * ruleInt('late_fee_per_hour_paise', 0),
    extra_km: extraKm,
    suggested_km_charge_paise: extraKm * ruleInt('extra_km_rate_paise', 0),
    deposit_held_paise: b.deposit_received_paise - b.deposit_refunded_paise,
  };
}

// ------------------------------------------------------------------ edits (BKA-05)
interface UpdateBookingInput {
  bookingId: string | null;
  carId: string | null;
  package: BookingPackage | null;
  customHours: number | null;
  pickupAt: string | null;
  pricePaise: number | null;
  reason: string | null;
  discountPaise: number | null;
  depositPaise: number | null;
  adminNotes: string | null;
}

function updateBooking(ctx: Ctx, input: UpdateBookingInput) {
  if (!isOwnerOrManager(ctx)) forbidden();
  const b = input.bookingId ? getRow<Booking>('bookings', input.bookingId) : undefined;
  if (!b) return bookingNotFound();
  const reason = clean(input.reason);
  const changes: string[] = [];

  const carId = input.carId ?? b.car_id;
  const pkg = input.package ?? b.package;
  const hours = pkg === '12h' ? 12 : pkg === '24h' ? 24 : (input.customHours ?? b.custom_hours);
  // Switching to a custom package needs its hours (the SQL version failed on return_due_at not null).
  if (hours === null) return fail('Some details are not valid. Check the form and try again.', 'invalid');
  const pickupAt = input.pickupAt ?? b.pickup_at;
  const returnAt = plusHours(pickupAt, hours);
  const car = getRow<Car>('cars', carId);
  if (!car) return fail('Choose a car.', 'car_id');
  const standard = pkg === '12h' ? car.price_12h_paise : pkg === '24h' ? car.price_24h_paise : null;

  const carOrPackageChanged = carId !== b.car_id || pkg !== b.package;
  const timesChanged = pickupAt !== b.pickup_at || returnAt !== b.return_due_at;
  const coreChange = carOrPackageChanged || timesChanged || (input.pricePaise !== null && input.pricePaise !== b.price_quoted_paise);

  let price = b.price_quoted_paise;
  if (coreChange) {
    if (b.status !== 'requested' && b.status !== 'confirmed') {
      fail('You can change the car, package, time or price only before pickup.', 'state');
    }
    if (input.pricePaise !== null) {
      price = input.pricePaise;
      if (price !== standard && reason === null) fail('A price override needs a reason.', 'price_reason');
    } else if (carOrPackageChanged) {
      price = standard ?? b.price_quoted_paise;
    }
    if (b.status === 'confirmed' && (carId !== b.car_id || timesChanged)) {
      const clash = carClashes(carId, pickupAt, returnAt, b.id)[0];
      if (clash) fail(clashMessage(clash), 'clash');
      if (car.status !== 'active') fail('This car is inactive.', 'car_inactive');
      if (carPaperProblems(carId, returnAt).some((p) => p.problem === 'expired')) {
        fail("This car's insurance, PUC or permit expires before the return time.", 'papers_expired');
      }
    }
    if (carId !== b.car_id) changes.push(`car → ${car.display_name}`);
    if (pkg !== b.package) changes.push(`package → ${pkg}`);
    if (pickupAt !== b.pickup_at) changes.push(`pickup → ${formatWhen(pickupAt)}`);
    if (price !== b.price_quoted_paise) changes.push(`price → ${formatRupees(price)}`);
  }

  if (input.discountPaise !== null && input.discountPaise !== b.discount_paise) {
    if (reason === null) fail('A discount needs a reason.', 'price_reason');
    changes.push(`discount → ${formatRupees(input.discountPaise)}`);
  }
  if (input.depositPaise !== null && input.depositPaise !== b.deposit_paise) changes.push(`deposit → ${formatRupees(input.depositPaise)}`);
  if (input.adminNotes !== null && input.adminNotes !== b.admin_notes) changes.push('notes updated');

  if (changes.length === 0) return { ok: true, changed: false };

  saveBooking(ctx, b, {
    car_id: carId,
    package: pkg,
    custom_hours: pkg === 'custom' ? hours : null,
    pickup_at: pickupAt,
    return_due_at: returnAt,
    price_quoted_paise: price,
    discount_paise: input.discountPaise ?? b.discount_paise,
    deposit_paise: input.depositPaise ?? b.deposit_paise,
    admin_notes: input.adminNotes ?? b.admin_notes,
  });
  addEvent(ctx, b.id, 'edit', `Changed: ${changes.join(', ')}${reason !== null ? `. Reason: ${reason}` : ''}`);
  return { ok: true, changed: true };
}

// ------------------------------------------------------------------ extension (BKA-09)
function extendBooking(ctx: Ctx, bookingId: string | null, kind: string | null, hoursIn: number | null, amountPaise: number | null, reasonIn: string | null) {
  if (!isOwnerOrManager(ctx)) forbidden();
  const b = bookingId ? getRow<Booking>('bookings', bookingId) : undefined;
  if (!b) return bookingNotFound();
  if (b.status !== 'active') fail('Only an Active booking can be extended.', 'state');
  const car = getRow<Car>('cars', b.car_id)!;
  const add = kind === '12h' ? 12 : kind === '24h' ? 24 : kind === 'hours' ? hoursIn : null;
  if (add === null || add < 1 || add > 240) return fail('Choose how long to extend by.', 'hours');
  const newReturn = plusHours(b.return_due_at, add);

  const clash = carClashes(b.car_id, b.return_due_at, newReturn, b.id)[0];
  if (clash) {
    fail(
      clash.kind === 'booking'
        ? `The car is booked next from ${formatWhen(clash.starts_at)} (${clash.booking_code}). Extend for less time, or move that booking.`
        : `The car has maintenance from ${formatWhen(clash.starts_at)}.`,
      'clash',
    );
  }

  const rate = extraHourRate(car, { extra_hour_rate_paise: ruleInt('extra_hour_rate_paise', 0) });
  let price = kind === '12h' ? car.price_12h_paise : kind === '24h' ? car.price_24h_paise : add * rate;
  const reason = clean(reasonIn);
  if (amountPaise !== null && amountPaise !== price) {
    if (reason === null) fail('A price override needs a reason.', 'price_reason');
    price = amountPaise;
  }

  saveBooking(ctx, b, { return_due_at: newReturn, overdue_notified_at: null });
  if (price > 0) {
    insertRow(ctx, 'booking_charges', {
      booking_id: b.id,
      kind: 'extension',
      amount_paise: price,
      note: `Extended by ${add} hrs; return by ${formatWhen(newReturn)}${reason !== null ? `. ${reason}` : ''}`,
      added_by: ctx.userId,
    });
    recomputeLedger(ctx, b.id);
  }
  addEvent(ctx, b.id, 'edit', `Extended by ${add} hrs for ${formatRupees(price)}. New return by ${formatWhen(newReturn)}.`);
  return { ok: true, return_due_at: newReturn, price_paise: price };
}

// ------------------------------------------------------------------ ledger (PAY-01..03, HND-04)
/**
 * _recompute_ledger (was the ledger_changed trigger on payments and booking_charges): totals
 * on the booking follow its payments and charges. Call after every payment/charge write.
 */
export function recomputeLedger(ctx: Ctx, bookingId: string): void {
  const b = getRow<Booking>('bookings', bookingId);
  if (!b) return;
  const extra = one<{ extra: number }>('SELECT coalesce(sum(amount_paise), 0) AS extra FROM booking_charges WHERE booking_id = ?', bookingId)!;
  const pay = one<{ paid: number; refunded: number; deposit_received: number; deposit_refunded: number }>(
    `SELECT
       coalesce(sum(CASE WHEN type IN ('rent', 'extra') THEN amount_paise WHEN type = 'refund' THEN -amount_paise ELSE 0 END), 0) AS paid,
       coalesce(sum(CASE WHEN type = 'refund' THEN amount_paise ELSE 0 END), 0) AS refunded,
       coalesce(sum(CASE WHEN type = 'deposit' THEN amount_paise ELSE 0 END), 0) AS deposit_received,
       coalesce(sum(CASE WHEN type = 'deposit_refund' THEN amount_paise ELSE 0 END), 0) AS deposit_refunded
     FROM payments WHERE booking_id = ?`,
    bookingId,
  )!;
  saveBooking(ctx, b, {
    extra_charges_paise: Number(extra.extra),
    paid_paise: Number(pay.paid),
    refunded_paise: Number(pay.refunded),
    deposit_received_paise: Number(pay.deposit_received),
    deposit_refunded_paise: Number(pay.deposit_refunded),
  });
}

function addBookingCharge(ctx: Ctx, bookingId: string | null, kind: ChargeKind | null, amount: number | null, noteIn: string | null, documentId: string | null): string {
  const role = roleOf(ctx);
  if (!role) forbidden();
  const b = loadVisibleBooking(ctx, bookingId);
  if (b.status === 'requested' || b.status === 'rejected' || b.status === 'cancelled') {
    fail('Add charges once the booking is confirmed.', 'state');
  }
  if (b.status === 'closed' && role === 'staff') {
    fail('Only the Owner or a Manager can add charges to a closed booking.', 'forbidden', undefined, 403);
  }
  if (amount === null || amount <= 0) return fail('Enter an amount above zero.', 'amount');
  const note = noteIn?.trim() ?? '';
  if ((kind === 'damage' || kind === 'other' || kind === 'challan') && note === '') fail('Add a note describing the charge.', 'note');
  if (kind === null) return fail('Choose a valid option.', 'kind');

  const charge = insertRow<BookingCharge>(ctx, 'booking_charges', {
    booking_id: b.id,
    kind,
    amount_paise: amount,
    note,
    document_id: documentId,
    added_by: ctx.userId,
  });
  recomputeLedger(ctx, b.id);
  addEvent(ctx, b.id, 'charge', `Charge added: ${kind.replace(/_/g, ' ')} ${formatRupees(amount)}${note ? ` (${note})` : ''}`);
  return charge.id;
}

function removeBookingCharge(ctx: Ctx, chargeId: string | null, reason: string | null): null {
  if (!isOwnerOrManager(ctx)) forbidden();
  if (!clean(reason)) fail('Give a reason.', 'reason');
  const c = chargeId ? deleteRow<BookingCharge>(ctx, 'booking_charges', chargeId) : undefined;
  if (!c) return fail('Charge not found.', 'not_found', undefined, 404);
  recomputeLedger(ctx, c.booking_id);
  addEvent(ctx, c.booking_id, 'charge', `Charge removed: ${c.kind.replace(/_/g, ' ')} ${formatRupees(c.amount_paise)}. Reason: ${reason}`);
  return null;
}

const PAYMENT_EVENT_LABELS: Record<PaymentType, string> = {
  rent: 'Rent',
  deposit: 'Deposit',
  extra: 'Extra',
  refund: 'Refund',
  deposit_refund: 'Deposit refund',
};

interface PaymentInput {
  bookingId: string | null;
  amountPaise: number | null;
  type: PaymentType | null;
  method: PaymentMethod | null;
  reference: string | null;
  note: string | null;
  receiptDocumentId: string | null;
  receivedAt: string | null;
}

function recordPayment(ctx: Ctx, input: PaymentInput): string {
  const role = roleOf(ctx);
  if (!role) forbidden();
  const b = loadVisibleBooking(ctx, input.bookingId);
  const amount = input.amountPaise;
  if (amount === null || amount <= 0) return fail('Enter an amount above zero.', 'amount');
  const note = input.note?.trim() ?? '';
  // PAY-03: refunds need a reason and only Owner/Manager can record them.
  if (input.type === 'refund' || input.type === 'deposit_refund') {
    if (role === 'staff') fail('Only the Owner or a Manager can record refunds.', 'forbidden', undefined, 403);
    if (note === '') fail('Give a reason for the refund.', 'note');
    if (input.type === 'deposit_refund' && amount > b.deposit_received_paise - b.deposit_refunded_paise) {
      fail('The refund is more than the deposit held.', 'amount');
    }
  }
  if (input.type === null) return fail('Choose a valid option.', 'type');
  if (input.method === null) return fail('Choose a valid option.', 'method');
  const reference = clean(input.reference);

  const payment = insertRow<{ id: string }>(ctx, 'payments', {
    booking_id: b.id,
    amount_paise: amount,
    type: input.type,
    method: input.method,
    reference,
    note,
    receipt_document_id: input.receiptDocumentId,
    received_by: ctx.userId,
    received_at: input.receivedAt ?? nowIso(),
  });
  recomputeLedger(ctx, b.id);
  addEvent(
    ctx,
    b.id,
    'payment',
    `${PAYMENT_EVENT_LABELS[input.type]} ${formatRupees(amount)} by ${input.method.toUpperCase()}${reference !== null ? ` (ref ${reference})` : ''}`,
  );
  return payment.id;
}

/** Open fine, claim or dispute: hold the booking's documents (10.4). */
function setBookingHold(ctx: Ctx, bookingId: string | null, onHold: boolean, reason: string | null): null {
  if (!isOwnerOrManager(ctx)) forbidden();
  if (onHold && !clean(reason)) fail('Give a reason for the hold.', 'reason');
  const b = bookingId ? getRow<Booking>('bookings', bookingId) : undefined;
  if (!b) return bookingNotFound();
  saveBooking(ctx, b, { on_hold: onHold, hold_reason: onHold ? reason : null });
  addEvent(ctx, b.id, 'note', onHold ? `Put on hold: ${reason}` : 'Hold removed');
  return null;
}

// ------------------------------------------------------------------ public booking lookup (5.5)
function lookupBooking(ctx: Ctx, codeIn: string | null, phoneIn: string | null) {
  // 10 lookups per hour per (hashed) IP.
  if (!registerAttempt('lookup', null, ipHash(ctx.ip ?? 'unknown', config.rateLimitSalt), 0, 10)) {
    fail('Too many requests. Please call us.', 'rate_limited', undefined, 429);
  }
  const phone = normalizePhone(phoneIn);
  if (!phone) return { found: false };
  const r = one<{
    booking_code: string;
    status: BookingStatus;
    package: BookingPackage;
    custom_hours: number | null;
    pickup_at: string;
    return_due_at: string;
    display_name: string;
  }>(
    `SELECT b.booking_code, b.status, b.package, b.custom_hours, b.pickup_at, b.return_due_at, c.display_name
       FROM bookings b
       JOIN customers cu ON cu.id = b.customer_id
       JOIN cars c ON c.id = b.car_id
      WHERE b.booking_code = ? AND cu.phone = ?`,
    (codeIn ?? '').trim().toUpperCase(),
    phone,
  );
  if (!r) return { found: false };
  const status =
    r.status === 'requested'
      ? 'Requested'
      : r.status === 'confirmed'
        ? 'Confirmed'
        : r.status === 'cancelled' || r.status === 'rejected' || r.status === 'no_show'
          ? 'Cancelled'
          : r.status === 'active'
            ? 'On trip'
            : 'Completed';
  return {
    found: true,
    code: r.booking_code,
    status,
    car: r.display_name,
    package: packageLabel(r.package, r.custom_hours),
    pickup_at: r.pickup_at,
    return_due_at: r.return_due_at,
  };
}

// ------------------------------------------------------------------ reports (RPT-02, DSH-06)
/** Postgres round(x, n): halves round away from zero. */
function roundTo(x: number, digits: number): number {
  const f = 10 ** digits;
  return (Math.sign(x) * Math.round(Math.abs(x) * f)) / f;
}

function reportUtilisation(fromIso: string, toIso: string): UtilisationRow[] {
  const ms = (a: string, b: string) => Date.parse(b) - Date.parse(a);
  const now = nowIso();
  // Active cars, plus inactive ones that had a booking in the period.
  const cars = all<{ id: string; display_name: string }>(
    `SELECT c.id, c.display_name FROM cars c
      WHERE c.status = 'active' OR EXISTS (
        SELECT 1 FROM bookings b WHERE b.car_id = c.id AND b.pickup_at < ? AND coalesce(b.actual_return_at, b.return_due_at) > ?)
      ORDER BY c.sort_order, c.display_name`,
    toIso,
    fromIso,
  );
  const maintenanceMs = new Map<string, number>();
  for (const m of all<{ car_id: string; starts_at: string; ends_at: string }>(
    'SELECT car_id, starts_at, ends_at FROM maintenance_windows WHERE starts_at < ? AND ends_at > ?',
    toIso,
    fromIso,
  )) {
    maintenanceMs.set(m.car_id, (maintenanceMs.get(m.car_id) ?? 0) + ms(laterOf(m.starts_at, fromIso), earlierOf(m.ends_at, toIso)));
  }
  const rentedMs = new Map<string, number>();
  for (const b of all<{ car_id: string; status: string; pickup_at: string; actual_pickup_at: string | null; actual_return_at: string | null; return_due_at: string }>(
    `SELECT car_id, status, pickup_at, actual_pickup_at, actual_return_at, return_due_at FROM bookings
      WHERE status IN ('active', 'returned', 'closed')
        AND coalesce(actual_pickup_at, pickup_at) < ? AND coalesce(actual_return_at, return_due_at) > ?`,
    toIso,
    fromIso,
  )) {
    // An Active car counts as rented up to now.
    const end = earlierOf(b.actual_return_at ?? (b.status === 'active' ? earlierOf(now, toIso) : b.return_due_at), toIso);
    const start = laterOf(b.actual_pickup_at ?? b.pickup_at, fromIso);
    rentedMs.set(b.car_id, (rentedMs.get(b.car_id) ?? 0) + Math.max(0, ms(start, end)));
  }
  const periodHours = ms(fromIso, toIso) / MS_HOUR;
  return cars.map((c) => {
    const available = periodHours - (maintenanceMs.get(c.id) ?? 0) / MS_HOUR;
    const rented = (rentedMs.get(c.id) ?? 0) / MS_HOUR;
    return {
      car_id: c.id,
      display_name: c.display_name,
      hours_available: roundTo(Math.max(0, available), 1),
      hours_rented: roundTo(rented, 1),
      utilisation: available > 0 ? roundTo(rented / available, 4) : 0,
    };
  });
}

// ------------------------------------------------------------------ RPCs
// Same names and p_* arguments as the SQL functions, so the web app calls them unchanged.
const reqTs = (a: Record<string, unknown>, k: string): string => ts(a, k) ?? fail('Enter a valid date and time.', k.replace(/^p_/, ''));

defineRpc('public_busy_windows', 'public', (_ctx, a) => publicBusyWindows(ts(a, 'p_from'), ts(a, 'p_to')));

defineRpc('lookup_booking', 'public', (ctx, a) => lookupBooking(ctx, str(a, 'p_code'), str(a, 'p_phone')));

defineRpc('car_clashes', 'user', (ctx, a) => {
  if (!isAdmin(ctx)) forbidden();
  return carClashes(str(a, 'p_car') ?? '', reqTs(a, 'p_start'), reqTs(a, 'p_end'), str(a, 'p_exclude'));
});

defineRpc('car_paper_problems', 'user', (ctx, a) => {
  if (!isOwnerOrManager(ctx)) forbidden();
  return carPaperProblems(str(a, 'p_car') ?? '', ts(a, 'p_until') ?? nowIso());
});

defineRpc('admin_create_booking', 'user', (ctx, a) => {
  if (!isOwnerOrManager(ctx)) forbidden();
  const source = oneOf(a, 'p_source', BOOKING_SOURCES);
  if (source === null || source === 'website') fail('Choose phone, walk-in or WhatsApp as the source.', 'source');
  if (!bool(a, 'p_consent_confirmed')) fail('Confirm the customer agreed to how we use their details.', 'consent');
  const pkg = oneOf(a, 'p_package', PACKAGES, 'Choose a 12 hr or 24 hr package.');
  const priceOverride = int(a, 'p_price_override_paise');
  if (pkg === 'custom' && priceOverride === null) fail('Enter a price for a custom package.', 'price');
  if (pkg === null) return fail('Choose a 12 hr or 24 hr package.', 'package');
  return createBooking(ctx, {
    carId: str(a, 'p_car_id') ?? '',
    package: pkg,
    pickupAt: ts(a, 'p_pickup_at') ?? '',
    customHours: int(a, 'p_custom_hours'),
    fullName: str(a, 'p_full_name') ?? '',
    phone: str(a, 'p_phone') ?? '',
    dlNumber: str(a, 'p_dl_number') ?? '',
    email: str(a, 'p_email'),
    source,
    createdBy: ctx.userId,
    noticeVersion: currentNoticeVersion(),
    consentChannel: 'admin',
    ip: ctx.ip,
    userAgent: ctx.ua,
    rejectOnClash: false,
    staff: true,
    priceOverridePaise: priceOverride,
    overrideReason: str(a, 'p_override_reason'),
    adminNotes: str(a, 'p_admin_notes') ?? '',
    depositPaise: int(a, 'p_deposit_paise'),
  });
});

defineRpc('booking_transition', 'user', (ctx, a) =>
  guardOverlap(() => {
    const to = oneOf(a, 'p_to', BOOKING_STATUSES) ?? fail('Choose a valid option.', 'to');
    return bookingTransition(ctx, str(a, 'p_booking'), to, str(a, 'p_note'), str(a, 'p_override_reason'));
  }),
);

defineRpc('pickup_gate_problems', 'user', (ctx, a) => {
  const id = str(a, 'p_booking');
  if (!id || !canSeeBooking(ctx, id)) bookingNotFound();
  return pickupGateProblems(getRow<Booking>('bookings', id)!);
});

defineRpc('record_handover', 'user', (ctx, a) =>
  recordHandover(ctx, {
    bookingId: str(a, 'p_booking'),
    kind: oneOf(a, 'p_kind', ['pickup', 'return'] as const) ?? fail('Choose a valid option.', 'kind'),
    odometerKm: int(a, 'p_odometer_km'),
    fuelLevel: oneOf(a, 'p_fuel_level', FUEL_LEVELS),
    checklist: json<unknown>(a, 'p_checklist', {}),
    damageNotes: str(a, 'p_damage_notes'),
    signatureDocumentId: str(a, 'p_signature_document_id'),
    overrideReason: str(a, 'p_override_reason'),
  }),
);

defineRpc('update_booking', 'user', (ctx, a) =>
  guardOverlap(() =>
    updateBooking(ctx, {
      bookingId: str(a, 'p_booking'),
      carId: str(a, 'p_car_id'),
      package: oneOf(a, 'p_package', PACKAGES, 'Choose a 12 hr or 24 hr package.'),
      customHours: int(a, 'p_custom_hours'),
      pickupAt: ts(a, 'p_pickup_at'),
      pricePaise: int(a, 'p_price_paise'),
      reason: str(a, 'p_reason'),
      discountPaise: int(a, 'p_discount_paise'),
      depositPaise: int(a, 'p_deposit_paise'),
      adminNotes: str(a, 'p_admin_notes'),
    }),
  ),
);

defineRpc('extend_booking', 'user', (ctx, a) =>
  guardOverlap(() =>
    extendBooking(ctx, str(a, 'p_booking'), str(a, 'p_kind'), int(a, 'p_hours'), int(a, 'p_amount_paise'), str(a, 'p_reason')),
  ),
);

defineRpc('add_booking_charge', 'user', (ctx, a) =>
  addBookingCharge(ctx, str(a, 'p_booking'), oneOf(a, 'p_kind', CHARGE_KINDS), int(a, 'p_amount_paise'), str(a, 'p_note'), str(a, 'p_document_id')),
);

defineRpc('remove_booking_charge', 'user', (ctx, a) => removeBookingCharge(ctx, str(a, 'p_charge'), str(a, 'p_reason')));

defineRpc('record_payment', 'user', (ctx, a) =>
  recordPayment(ctx, {
    bookingId: str(a, 'p_booking'),
    amountPaise: int(a, 'p_amount_paise'),
    type: oneOf(a, 'p_type', PAYMENT_TYPES),
    method: oneOf(a, 'p_method', PAYMENT_METHODS),
    reference: str(a, 'p_reference'),
    note: str(a, 'p_note'),
    receiptDocumentId: str(a, 'p_receipt_document_id'),
    receivedAt: ts(a, 'p_received_at'),
  }),
);

defineRpc('set_booking_hold', 'user', (ctx, a) => setBookingHold(ctx, str(a, 'p_booking'), bool(a, 'p_on_hold'), str(a, 'p_reason')));

defineRpc('report_utilisation', 'user', (ctx, a) => {
  if (!isOwnerOrManager(ctx)) forbidden();
  return reportUtilisation(reqTs(a, 'p_from'), reqTs(a, 'p_to'));
});
