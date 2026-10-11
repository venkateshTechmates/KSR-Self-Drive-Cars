// Date ranges for reports, the payments ledger and the audit log. Ranges are IST calendar
// days, both ends inclusive; queries use [start of `from`, start of the day after `to`).
import { addDaysIso, formatIsoDate, isIsoDate, istStartOfDay } from '@shared/time.ts';

export type RangePreset = 'this_month' | 'last_month' | 'last_7' | 'last_30' | 'last_90' | 'all' | 'custom';

export const PRESET_LABELS: Record<RangePreset, string> = {
  this_month: 'This month',
  last_month: 'Last month',
  last_7: 'Last 7 days',
  last_30: 'Last 30 days',
  last_90: 'Last 90 days',
  all: 'Any time',
  custom: 'Custom dates',
};

/** `from` / `to` are only read for the custom preset. */
export interface RangeState {
  preset: RangePreset;
  from: string;
  to: string;
}

export interface DayRange {
  from: string;
  to: string;
}

export interface RangeBounds {
  /** ISO instant, inclusive. */
  fromTs: string;
  /** ISO instant, exclusive. */
  toTs: string;
}

export const initialRange = (preset: RangePreset = 'this_month'): RangeState => ({ preset, from: '', to: '' });

/** Dates for a preset, given today's IST date. Null for "Any time" and custom. */
export function presetDates(preset: RangePreset, today: string): DayRange | null {
  const monthStart = `${today.slice(0, 8)}01`;
  switch (preset) {
    case 'this_month':
      return { from: monthStart, to: today };
    case 'last_month': {
      const end = addDaysIso(monthStart, -1);
      return { from: `${end.slice(0, 8)}01`, to: end };
    }
    case 'last_7':
      return { from: addDaysIso(today, -6), to: today };
    case 'last_30':
      return { from: addDaysIso(today, -29), to: today };
    case 'last_90':
      return { from: addDaysIso(today, -89), to: today };
    default:
      return null;
  }
}

/** The range to query, or an error to show next to the custom dates. `range` is null for "Any time". */
export function resolveRange(state: RangeState, today: string): { range: DayRange | null; error: string | null } {
  if (state.preset !== 'custom') return { range: presetDates(state.preset, today), error: null };
  if (!isIsoDate(state.from) || !isIsoDate(state.to)) return { range: null, error: 'Enter a start and an end date.' };
  if (state.from > state.to) return { range: null, error: 'The start date must be on or before the end date.' };
  return { range: { from: state.from, to: state.to }, error: null };
}

export function rangeBounds(range: DayRange): RangeBounds {
  return {
    fromTs: istStartOfDay(range.from).toISOString(),
    toTs: istStartOfDay(addDaysIso(range.to, 1)).toISOString(),
  };
}

/** "1 Oct 2026 – 11 Oct 2026", or one date when both ends match. */
export function describeRange(range: DayRange | null): string {
  if (!range) return 'Any time';
  if (range.from === range.to) return formatIsoDate(range.from);
  return `${formatIsoDate(range.from)} – ${formatIsoDate(range.to)}`;
}

/** Days in the range, counting both ends. */
export function rangeDays(range: DayRange): number {
  return Math.round((Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** Safe part of a file name, e.g. "2026-10-01_2026-10-11". */
export const rangeFileSuffix = (range: DayRange | null) => (range ? `${range.from}_${range.to}` : 'all');
