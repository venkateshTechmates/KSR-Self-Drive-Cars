// Time helpers. Times are stored in UTC and shown in India Standard Time (UTC+05:30,
// no daylight saving), so IST conversions are a fixed offset and need no tz database.
import type { DayHours, OpeningHours, Weekday } from './settings.ts';
import { WEEKDAYS } from './settings.ts';

export const IST_OFFSET_MINUTES = 330;
export const MS_MINUTE = 60_000;
export const MS_HOUR = 3_600_000;
export const MS_DAY = 86_400_000;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n: number) => String(n).padStart(2, '0');

export type DateInput = Date | string | number;
export const toDate = (d: DateInput): Date => (d instanceof Date ? d : new Date(d));

/** Wall-clock parts of an instant as seen in IST. */
export function istParts(input: DateInput) {
  const t = new Date(toDate(input).getTime() + IST_OFFSET_MINUTES * MS_MINUTE);
  return {
    year: t.getUTCFullYear(),
    month: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
    hour: t.getUTCHours(),
    minute: t.getUTCMinutes(),
    weekday: t.getUTCDay(),
  };
}

/** "YYYY-MM-DD" of the IST calendar day containing the instant. */
export function istDateIso(input: DateInput = new Date()): string {
  const p = istParts(input);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** "HH:MM" (24-hour) IST wall-clock time of the instant. */
export function istTime(input: DateInput): string {
  const p = istParts(input);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const isIsoDate = (s: string) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
export const isHHMM = (s: string) => TIME_RE.test(s);

/** Instant for an IST wall-clock date and time, or null if either part is malformed. */
export function fromIst(dateIso: string, time: string): Date | null {
  if (!isIsoDate(dateIso) || !isHHMM(time)) return null;
  const d = new Date(`${dateIso}T${time}:00+05:30`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Midnight IST at the start of the given IST date. */
export function istStartOfDay(dateIso: string): Date {
  return new Date(`${dateIso}T00:00:00+05:30`);
}

export function addDaysIso(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `fromIso` to `toIso` (both "YYYY-MM-DD"). Negative if `toIso` is earlier. */
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / MS_DAY);
}

export function weekdayOf(dateIso: string): Weekday {
  return WEEKDAYS[new Date(`${dateIso}T00:00:00Z`).getUTCDay()];
}

export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function hhmm(minutes: number): string {
  return `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;
}

/** "9:00 am" from "09:00". */
export function formatClock(time: string): string {
  const total = minutesOf(time);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h % 12 || 12}:${pad(m)} ${h >= 12 ? 'pm' : 'am'}`;
}

/** "Sat, 12 Oct, 9:00 am" (IST), the format used across the design. */
export function formatWhen(input: DateInput): string {
  const p = istParts(input);
  return `${DAYS[p.weekday]}, ${p.day} ${MONTHS[p.month - 1]}, ${formatClock(`${pad(p.hour)}:${pad(p.minute)}`)}`;
}

/** "12 Oct 2026" (IST). */
export function formatDate(input: DateInput): string {
  const p = istParts(input);
  return `${p.day} ${MONTHS[p.month - 1]} ${p.year}`;
}

/** "12 Oct 2026" from a plain "YYYY-MM-DD" date (no timezone shift). */
export function formatIsoDate(dateIso: string): string {
  const m = DATE_RE.exec(dateIso);
  if (!m) return dateIso;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/** "12 Oct 2026, 9:00 am" (IST). */
export function formatDateTime(input: DateInput): string {
  const p = istParts(input);
  return `${formatDate(input)}, ${formatClock(`${pad(p.hour)}:${pad(p.minute)}`)}`;
}

/** "Today, 9:00 am" / "Tomorrow, 9:00 am" / "Sat, 12 Oct, 9:00 am". */
export function formatRelativeDay(input: DateInput, now: DateInput = new Date()): string {
  const day = istDateIso(input);
  const today = istDateIso(now);
  const clock = formatClock(istTime(input));
  if (day === today) return `Today, ${clock}`;
  if (day === addDaysIso(today, 1)) return `Tomorrow, ${clock}`;
  if (day === addDaysIso(today, -1)) return `Yesterday, ${clock}`;
  return formatWhen(input);
}

/** Human duration such as "25 min", "2 h 5 min", "3 days". */
export function formatDuration(ms: number): string {
  const mins = Math.max(0, Math.round(ms / MS_MINUTE));
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) {
    const rem = mins % 60;
    return rem ? `${hours} h ${rem} min` : `${hours} h`;
  }
  return `${Math.floor(hours / 24)} days`;
}

/** Pickup slots for a day's opening hours, `step` minutes apart, open..close inclusive. */
export function timeSlots(hours: DayHours, stepMinutes: number): string[] {
  if (hours.closed || !isHHMM(hours.open) || !isHHMM(hours.close)) return [];
  const step = Math.max(5, stepMinutes || 30);
  const start = minutesOf(hours.open);
  const end = minutesOf(hours.close);
  const first = Math.ceil(start / step) * step;
  const out: string[] = [];
  for (let m = first; m <= end; m += step) out.push(hhmm(m));
  return out;
}

/** Slots for a date that are still at least `leadHours` away from `now`. */
export function availableSlots(
  dateIso: string,
  hours: OpeningHours,
  stepMinutes: number,
  leadHours: number,
  now: DateInput = new Date(),
): string[] {
  if (!isIsoDate(dateIso)) return [];
  const earliest = toDate(now).getTime() + leadHours * MS_HOUR;
  return timeSlots(hours[weekdayOf(dateIso)], stepMinutes).filter((t) => {
    const at = fromIst(dateIso, t);
    return at !== null && at.getTime() >= earliest;
  });
}

/** Does [aStart, aEnd) overlap [bStart, bEnd)? */
export function overlaps(aStart: DateInput, aEnd: DateInput, bStart: DateInput, bEnd: DateInput): boolean {
  return toDate(aStart).getTime() < toDate(bEnd).getTime() && toDate(bStart).getTime() < toDate(aEnd).getTime();
}

/** Value for <input type="datetime-local"> in IST, e.g. "2026-10-12T09:00". */
export function toIstLocalInput(input: DateInput): string {
  return `${istDateIso(input)}T${istTime(input)}`;
}

/** Instant from an IST <input type="datetime-local"> value. */
export function fromIstLocalInput(value: string): Date | null {
  const [d, t] = value.split('T');
  return d && t ? fromIst(d, t.slice(0, 5)) : null;
}
