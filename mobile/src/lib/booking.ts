// Booking form helpers (pure, unit tested in test/booking.test.ts). The rules themselves come
// from ../shared, exactly as on the website and the server.
import type { OpeningHours } from '@shared/settings.ts';
import { addDaysIso, overlaps, weekdayOf } from '@shared/time.ts';
import type { BusyWindow } from './types';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface PickupDay {
  date: string;
  label: string;
  sub: string;
  closed: boolean;
}

/** "Today", "Tomorrow", then "Wed" with "14 Oct" underneath, for the booking window. */
export function pickupDays(today: string, windowDays: number, hours: OpeningHours): PickupDay[] {
  const out: PickupDay[] = [];
  for (let i = 0; i <= windowDays; i++) {
    const date = addDaysIso(today, i);
    const [, m, d] = date.split('-').map(Number);
    const weekday = DAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
    out.push({
      date,
      label: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : weekday,
      sub: `${d} ${MONTHS[m - 1]}`,
      closed: hours[weekdayOf(date)].closed,
    });
  }
  return out;
}

/** Why a car can't be booked for [pickup, return + turnaround), if it can't. */
export function busyKind(
  busy: BusyWindow[] | undefined,
  carId: string,
  pickupAt: Date | null,
  returnAt: Date | null,
  bufferMinutes: number,
): 'booking' | 'maintenance' | null {
  if (!busy || !pickupAt || !returnAt) return null;
  const end = new Date(returnAt.getTime() + bufferMinutes * 60_000);
  let kind: 'booking' | 'maintenance' | null = null;
  for (const w of busy) {
    if (w.car_id !== carId || !overlaps(pickupAt, end, w.starts_at, w.ends_at)) continue;
    if (w.kind === 'maintenance') return 'maintenance';
    kind = 'booking';
  }
  return kind;
}

export const busyText = (kind: 'booking' | 'maintenance' | null) =>
  kind === 'maintenance' ? 'Not available on this date' : kind === 'booking' ? 'Booked at this time' : null;
