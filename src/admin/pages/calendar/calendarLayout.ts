// Geometry and colours for the fleet calendar (CAL-01). Times are UTC instants; the grid
// starts at midnight IST, so x = hours since range start × pixels per hour.
import { BOOKING_STATUS_LABELS, type BookingPackage, type BookingStatus } from '@shared/constants.ts';
import { displayStatus, type DisplayStatus } from '@shared/booking.ts';
import { MS_MINUTE } from '@shared/time.ts';

export type CalendarView = 'day' | 'week';

/** Pixels per hour: day view shows hours, week view squeezes 7 days. */
export const HOUR_PX: Record<CalendarView, number> = { day: 64, week: 9 };
/** Drag and tap snapping. */
export const SNAP_MS: Record<CalendarView, number> = { day: 30 * MS_MINUTE, week: 60 * MS_MINUTE };
export const BAR_H = 44;
export const LANE_H = 50;
export const ROW_PAD = 4;

export const VISIBLE_STATUSES: BookingStatus[] = ['requested', 'confirmed', 'active', 'returned', 'closed'];
export const CANCELLED_STATUSES: BookingStatus[] = ['rejected', 'cancelled', 'no_show'];
/** Bookings that can be moved by dragging (update_booking allows edits before pickup). */
export const MOVABLE: readonly BookingStatus[] = ['requested', 'confirmed'];

export interface CalBooking {
  id: string;
  booking_code: string;
  car_id: string;
  status: BookingStatus;
  package: BookingPackage;
  pickup_at: string;
  return_due_at: string;
  actual_return_at: string | null;
  customer: { full_name: string } | null;
}

export const CAL_BOOKING_SELECT =
  'id, booking_code, car_id, status, package, pickup_at, return_due_at, actual_return_at, customer:customers(full_name)';

export interface PlacedBooking {
  booking: CalBooking;
  start: number;
  end: number;
  status: DisplayStatus;
  lane: number;
}

/** Bar span: Active bookings run to now when overdue; returned ones end at the actual return. */
export function bookingSpan(b: CalBooking, now: number): { start: number; end: number } {
  const start = Date.parse(b.pickup_at);
  let end = Date.parse(b.return_due_at);
  if (b.status === 'active') end = Math.max(end, now);
  else if ((b.status === 'returned' || b.status === 'closed') && b.actual_return_at) end = Date.parse(b.actual_return_at);
  return { start, end: Math.max(end, start + 30 * MS_MINUTE) };
}

/** Stack overlapping bookings into lanes so none hide each other. */
export function placeBookings(list: CalBooking[], now: number): { placed: PlacedBooking[]; lanes: number } {
  const items = list
    .map((booking) => ({ booking, ...bookingSpan(booking, now), status: displayStatus(booking, now) }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const laneEnds: number[] = [];
  const placed = items.map((item) => {
    let lane = laneEnds.findIndex((end) => end <= item.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(item.end);
    } else {
      laneEnds[lane] = item.end;
    }
    return { ...item, lane };
  });
  return { placed, lanes: Math.max(1, laneEnds.length) };
}

export const rowHeight = (lanes: number) => ROW_PAD * 2 + lanes * LANE_H;

export const statusLabel = (s: DisplayStatus) => (s === 'overdue' ? 'Overdue' : BOOKING_STATUS_LABELS[s]);

/** Appendix C colours, always shown with a text label. */
export const BAR_CLASS: Record<DisplayStatus, string> = {
  requested: 'bg-amber-100 border-amber-600 text-amber-950',
  confirmed: 'bg-blue-100 border-blue-600 text-blue-950',
  active: 'bg-emerald-100 border-emerald-700 text-emerald-950',
  overdue: 'bg-red-100 border-red-700 text-red-950',
  returned: 'bg-teal-100 border-teal-700 text-teal-950',
  closed: 'bg-zinc-100 border-zinc-500 text-zinc-800',
  rejected: 'bg-white border-dashed border-zinc-400 text-zinc-700',
  cancelled: 'bg-white border-dashed border-zinc-400 text-zinc-700',
  no_show: 'bg-white border-dashed border-zinc-400 text-zinc-700',
};

export const LEGEND: DisplayStatus[] = ['requested', 'confirmed', 'active', 'overdue', 'returned', 'closed'];

export const HATCH_STYLE = {
  backgroundImage: 'repeating-linear-gradient(135deg, rgb(29 33 37 / 0.18) 0 6px, rgb(29 33 37 / 0.05) 6px 12px)',
};

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Mon 12 Oct" from "2026-10-12". */
export function dayLabel(dateIso: string): string {
  const [y, m, d] = dateIso.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DAYS[weekday]} ${d} ${MONTHS[m - 1]}`;
}

/** "9 am" / "12 pm" for an hour of the day. */
export const hourLabel = (h: number) => `${h % 12 || 12} ${h < 12 ? 'am' : 'pm'}`;
