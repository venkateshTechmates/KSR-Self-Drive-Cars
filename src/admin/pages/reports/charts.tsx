// Chart building blocks for Reports. Every chart is a single series in one validated hue
// (no colour-coded identity), has a written summary, and a table view with the same numbers.
import { useId, useState, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { cn } from '@/lib/cn';

/** Series hue (passes the palette checks on the white surface). */
const SERIES_COLOR = '#2a78d6';
/** Ordinal ramp for ordered stages (funnel), light to dark, one hue; validated with --ordinal. */
const ORDINAL_COLORS = ['#6da7ec', '#2a78d6', '#184f95'];
const GRID = '#e1e0d9';
const AXIS = '#c3c2b7';
const TICK = '#555c63';
const INK = '#1d2125';

export interface BarDatum {
  key: string;
  /** Full label (tooltip, table). */
  label: string;
  /** Short axis label; defaults to `label`. */
  tick?: string;
  value: number;
  /** Formatted value shown at the bar tip and in the tooltip. */
  valueLabel: string;
  /** Optional second line in the tooltip. */
  detail?: string;
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function TooltipBox({ datum }: { datum: BarDatum | undefined }) {
  if (!datum) return null;
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-sm shadow-md">
      <p className="m-0 text-[15px] font-bold text-ink">{datum.valueLabel}</p>
      <p className="m-0 text-muted">{datum.label}</p>
      {datum.detail && <p className="m-0 text-muted">{datum.detail}</p>}
    </div>
  );
}

const firstDatum = (payload: unknown): BarDatum | undefined =>
  (payload as ReadonlyArray<{ payload?: BarDatum }> | undefined)?.[0]?.payload;

/** Horizontal bars with the value at each tip: comparisons across cars, packages, methods, sources. */
export function HBarChart({
  data,
  ordinal,
  formatTick,
  domain,
  labelWidth = 116,
  tipSpace = 88,
}: {
  data: BarDatum[];
  /** Ordered stages (funnel): bars step light to dark in the same hue. Otherwise one hue throughout. */
  ordinal?: boolean;
  formatTick?: (v: number) => string;
  domain?: [number, number];
  labelWidth?: number;
  /** Room on the right for the value labels. */
  tipSpace?: number;
}) {
  const height = data.length * 40 + 40;
  return (
    <div className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: tipSpace, bottom: 4, left: 4 }} barCategoryGap="22%">
          <CartesianGrid horizontal={false} stroke={GRID} />
          <XAxis
            type="number"
            domain={domain ?? [0, 'auto']}
            tickFormatter={formatTick}
            tick={{ fill: TICK, fontSize: 12 }}
            stroke={AXIS}
            tickLine={false}
            allowDecimals={false}
          />
          <YAxis
            type="category"
            dataKey="label"
            width={labelWidth}
            tick={{ fill: INK, fontSize: 13 }}
            tickFormatter={(v: string) => truncate(String(v), 15)}
            stroke={AXIS}
            tickLine={false}
            interval={0}
          />
          <Tooltip cursor={{ fill: 'rgba(29,33,37,0.06)' }} content={({ payload }) => <TooltipBox datum={firstDatum(payload)} />} />
          <Bar dataKey="value" fill={SERIES_COLOR} radius={[0, 4, 4, 0]} maxBarSize={24} isAnimationActive={false}>
            {ordinal && data.map((d, i) => <Cell key={d.key} fill={ORDINAL_COLORS[Math.min(i, ORDINAL_COLORS.length - 1)]} />)}
            <LabelList dataKey="valueLabel" position="right" fill={INK} fontSize={13} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Columns over time (day / week / month). Values are read from the axis, tooltip and table. */
export function ColumnChart({ data, formatTick }: { data: BarDatum[]; formatTick?: (v: number) => string }) {
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="20%">
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis dataKey="tick" tick={{ fill: TICK, fontSize: 12 }} stroke={AXIS} tickLine={false} minTickGap={12} interval="preserveStartEnd" />
          <YAxis tickFormatter={formatTick} tick={{ fill: TICK, fontSize: 12 }} width={64} axisLine={false} tickLine={false} />
          <ReferenceLine y={0} stroke={AXIS} />
          <Tooltip cursor={{ fill: 'rgba(29,33,37,0.06)' }} content={({ payload }) => <TooltipBox datum={firstDatum(payload)} />} />
          <Bar dataKey="value" fill={SERIES_COLOR} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Title, written summary, and a Chart / Table switch (the table is the text alternative). */
export function ChartFrame({
  title,
  summary,
  chart,
  table,
  className,
}: {
  title: string;
  summary: ReactNode;
  chart: ReactNode;
  table: ReactNode;
  className?: string;
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const headingId = useId();
  const btn = (v: 'chart' | 'table', label: string) => (
    <button
      type="button"
      aria-pressed={view === v}
      onClick={() => setView(v)}
      className={cn(
        'min-h-11 rounded-full px-4 text-sm font-semibold',
        view === v ? 'bg-ink text-white' : 'bg-transparent text-ink hover:bg-ink/5',
      )}
    >
      {label}
    </button>
  );
  return (
    <section aria-labelledby={headingId} className={cn('flex min-w-0 flex-col gap-3', className)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={headingId} className="m-0 text-base font-bold">
            {title}
          </h3>
          <p className="m-0 mt-0.5 text-sm text-muted">{summary}</p>
        </div>
        <div role="group" aria-label={`Show ${title.toLowerCase()} as`} className="inline-flex shrink-0 rounded-full border border-line-input bg-white p-0.5">
          {btn('chart', 'Chart')}
          {btn('table', 'Table')}
        </div>
      </div>
      {view === 'chart' ? chart : table}
    </section>
  );
}

/** Plain, accessible table used as each chart's text alternative and for report lists. */
export function SimpleTable({
  caption,
  headers,
  rows,
  numeric = [],
  empty = 'Nothing in this range.',
}: {
  caption: string;
  headers: string[];
  rows: Array<{ key: string; cells: ReactNode[] }>;
  /** Column indexes to right-align. */
  numeric?: number[];
  empty?: string;
}) {
  if (rows.length === 0) return <p className="m-0 rounded-xl bg-subtle px-4 py-3 text-[15px] text-muted">{empty}</p>;
  return (
    <div className="overflow-x-auto rounded-xl border border-line-card">
      <table className="w-full border-collapse text-left text-[15px]">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-line-card bg-subtle">
            {headers.map((h, i) => (
              <th key={h} scope="col" className={cn('px-3 py-2 text-[13px] font-semibold whitespace-nowrap text-muted', numeric.includes(i) && 'text-right')}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-b border-line-card last:border-0">
              {r.cells.map((c, i) =>
                i === 0 ? (
                  <th key={i} scope="row" className="px-3 py-2 text-left font-semibold">
                    {c}
                  </th>
                ) : (
                  <td key={i} className={cn('px-3 py-2', numeric.includes(i) && 'text-right whitespace-nowrap tabular-nums')}>
                    {c}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Headline number with a label and an optional explanation. */
export function StatTile({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-2xl border border-line-card bg-surface px-4 py-3">
      <p className="m-0 text-sm text-muted">{label}</p>
      <p className="m-0 mt-1 text-[22px] leading-tight font-extrabold break-words">{value}</p>
      {hint && <p className="m-0 mt-1 text-[13px] text-muted">{hint}</p>}
    </div>
  );
}
