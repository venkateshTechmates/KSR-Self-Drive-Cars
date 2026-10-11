// Pure aggregations for Reports (RPT-01..04). Money is paise; dates are IST.
import {
  BOOKING_SOURCES,
  PACKAGE_LABELS,
  PACKAGES,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  SOURCE_LABELS,
  type BookingSource,
  type BookingStatus,
} from '@shared/constants.ts';
import { addDaysIso, formatIsoDate, istDateIso } from '@shared/time.ts';
import type { DayRange } from './range';
import { revenueEffect, type PaymentWithBooking } from './reportData';

export type Grain = 'day' | 'week' | 'month';
export const GRAIN_LABELS: Record<Grain, string> = { day: 'Day', week: 'Week', month: 'Month' };

/** Sensible default: days for a month or less, weeks up to ~4 months, then months. */
export function autoGrain(days: number): Grain {
  if (days <= 35) return 'day';
  if (days <= 130) return 'week';
  return 'month';
}

const noYear = (dateIso: string) => formatIsoDate(dateIso).replace(/ \d{4}$/, '');
const monthName = (ym: string) => formatIsoDate(`${ym}-01`).replace(/^\d+ /, '');

function mondayOf(dateIso: string): string {
  const wd = new Date(`${dateIso}T00:00:00Z`).getUTCDay();
  return addDaysIso(dateIso, -((wd + 6) % 7));
}

function bucketOf(dateIso: string, grain: Grain): string {
  if (grain === 'day') return dateIso;
  if (grain === 'week') return mondayOf(dateIso);
  return dateIso.slice(0, 7);
}

function bucketLabels(key: string, grain: Grain): { label: string; tick: string } {
  if (grain === 'day') return { label: formatIsoDate(key), tick: noYear(key) };
  if (grain === 'week') return { label: `Week of ${formatIsoDate(key)}`, tick: noYear(key) };
  return { label: monthName(key), tick: monthName(key).replace(/ \d{4}$/, '') };
}

/** Every bucket in the range, so empty days show as zero rather than vanishing. */
function bucketKeys(range: DayRange, grain: Grain): string[] {
  const keys: string[] = [];
  let d = range.from;
  let guard = 0;
  while (d <= range.to && guard++ < 4000) {
    const k = bucketOf(d, grain);
    if (keys[keys.length - 1] !== k) keys.push(k);
    d = addDaysIso(d, 1);
  }
  return keys;
}

export interface PeriodRow {
  key: string;
  label: string;
  tick: string;
  rent: number;
  extra: number;
  refund: number;
  net: number;
}

export function revenueByPeriod(payments: PaymentWithBooking[], range: DayRange, grain: Grain): PeriodRow[] {
  const rows = new Map<string, PeriodRow>(
    bucketKeys(range, grain).map((k) => [k, { key: k, ...bucketLabels(k, grain), rent: 0, extra: 0, refund: 0, net: 0 }]),
  );
  for (const p of payments) {
    const row = rows.get(bucketOf(istDateIso(p.received_at), grain));
    if (!row) continue;
    if (p.type === 'rent') row.rent += p.amount_paise;
    else if (p.type === 'extra') row.extra += p.amount_paise;
    else if (p.type === 'refund') row.refund += p.amount_paise;
    row.net += revenueEffect(p);
  }
  return [...rows.values()];
}

export interface GroupRow {
  key: string;
  label: string;
  /** Rent + extra received. */
  received: number;
  refunded: number;
  net: number;
}

function groupRevenue(payments: PaymentWithBooking[], keyOf: (p: PaymentWithBooking) => [string, string]): Map<string, GroupRow> {
  const out = new Map<string, GroupRow>();
  for (const p of payments) {
    const effect = revenueEffect(p);
    if (effect === 0) continue;
    const [key, label] = keyOf(p);
    const row = out.get(key) ?? { key, label, received: 0, refunded: 0, net: 0 };
    if (effect > 0) row.received += effect;
    else row.refunded -= effect;
    row.net += effect;
    out.set(key, row);
  }
  return out;
}

export function revenueByCar(payments: PaymentWithBooking[]): GroupRow[] {
  const rows = groupRevenue(payments, (p) => [p.booking?.car?.id ?? 'unknown', p.booking?.car?.display_name ?? 'Unknown car']);
  return [...rows.values()].sort((a, b) => b.net - a.net || a.label.localeCompare(b.label));
}

export function revenueByPackage(payments: PaymentWithBooking[]): GroupRow[] {
  const rows = groupRevenue(payments, (p) => {
    const pkg = p.booking?.package ?? 'custom';
    return [pkg, PACKAGE_LABELS[pkg]];
  });
  return PACKAGES.map((k) => rows.get(k) ?? { key: k, label: PACKAGE_LABELS[k], received: 0, refunded: 0, net: 0 });
}

export function revenueByMethod(payments: PaymentWithBooking[]): GroupRow[] {
  const rows = groupRevenue(payments, (p) => [p.method, PAYMENT_METHOD_LABELS[p.method]]);
  return PAYMENT_METHODS.map((k) => rows.get(k) ?? { key: k, label: PAYMENT_METHOD_LABELS[k], received: 0, refunded: 0, net: 0 });
}

// ---------------------------------------------------------------- bookings funnel & sources

export interface CreatedBooking {
  id: string;
  status: BookingStatus;
  source: BookingSource;
  cancel_reason: string | null;
  created_at: string;
  /** Only the "confirmed" status events (filtered in the query). */
  booking_events: Array<{ to_status: BookingStatus | null }>;
}

const CONFIRMED_LATER: readonly BookingStatus[] = ['confirmed', 'active', 'returned', 'closed', 'no_show'];
const COMPLETED: readonly BookingStatus[] = ['returned', 'closed'];

export const wasConfirmed = (b: CreatedBooking) => CONFIRMED_LATER.includes(b.status) || b.booking_events.length > 0;
export const isCompleted = (b: CreatedBooking) => COMPLETED.includes(b.status);

export interface Funnel {
  requested: number;
  confirmed: number;
  completed: number;
  waiting: number;
  inProgress: number;
  rejected: number;
  cancelled: number;
  cancelledAfterConfirm: number;
  noShow: number;
}

export function funnelOf(bookings: CreatedBooking[]): Funnel {
  const f: Funnel = { requested: bookings.length, confirmed: 0, completed: 0, waiting: 0, inProgress: 0, rejected: 0, cancelled: 0, cancelledAfterConfirm: 0, noShow: 0 };
  for (const b of bookings) {
    if (wasConfirmed(b)) f.confirmed += 1;
    if (isCompleted(b)) f.completed += 1;
    if (b.status === 'requested') f.waiting += 1;
    if (b.status === 'confirmed' || b.status === 'active') f.inProgress += 1;
    if (b.status === 'rejected') f.rejected += 1;
    if (b.status === 'no_show') f.noShow += 1;
    if (b.status === 'cancelled') {
      f.cancelled += 1;
      if (b.booking_events.length > 0) f.cancelledAfterConfirm += 1;
    }
  }
  return f;
}

export interface ReasonRow {
  key: string;
  reason: string;
  rejected: number;
  cancelled: number;
  total: number;
}

/** Rejection and cancellation reasons, grouped case-insensitively. */
export function reasonsOf(bookings: CreatedBooking[]): ReasonRow[] {
  const out = new Map<string, ReasonRow>();
  for (const b of bookings) {
    if (b.status !== 'rejected' && b.status !== 'cancelled') continue;
    const text = (b.cancel_reason ?? '').trim().replace(/\s+/g, ' ').replace(/[.!]+$/, '');
    const key = text.toLowerCase() || '—';
    const row = out.get(key) ?? { key, reason: text || 'No reason given', rejected: 0, cancelled: 0, total: 0 };
    if (b.status === 'rejected') row.rejected += 1;
    else row.cancelled += 1;
    row.total += 1;
    out.set(key, row);
  }
  return [...out.values()].sort((a, b) => b.total - a.total || a.reason.localeCompare(b.reason));
}

export interface SourceRow {
  key: BookingSource;
  label: string;
  bookings: number;
  confirmed: number;
  completed: number;
}

export function sourcesOf(bookings: CreatedBooking[]): SourceRow[] {
  return BOOKING_SOURCES.map((s) => {
    const mine = bookings.filter((b) => b.source === s);
    return {
      key: s,
      label: SOURCE_LABELS[s],
      bookings: mine.length,
      confirmed: mine.filter(wasConfirmed).length,
      completed: mine.filter(isCompleted).length,
    };
  });
}
