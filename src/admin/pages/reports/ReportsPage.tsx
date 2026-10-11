// /admin/reports (RPT-01..06, Owner and Manager). Revenue, utilisation, the bookings funnel,
// sources, document alerts and CSV exports for one IST date range. Exports are audited and
// never include KYC data or document numbers.
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Download } from 'lucide-react';
import {
  BOOKING_STATUS_LABELS,
  PACKAGE_LABELS,
  PAYMENT_STATUS_LABELS,
  SOURCE_LABELS,
} from '@shared/constants.ts';
import { expiryState } from '@shared/documents.ts';
import { addDaysIso, daysBetween } from '@shared/time.ts';
import { ExpiryPill } from '@/components/ui/Badges';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Field';
import { Card, CardBody, CardHeader, Chip, PageHeader, Toolbar } from '@/components/ui/Layout';
import { Spinner } from '@/components/ui/Spinner';
import { api } from '@/integrations/api/client';
import { cn } from '@/lib/cn';
import { downloadCsv, type CsvValue } from '@/lib/csv';
import { errorMessage, unwrap } from '@/lib/errors';
import { formatDateTime, formatIsoDate, formatPhone, formatRupees, istDateIso, pluralize } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import type { BookingWithRefs, UtilisationRow } from '@/types/db';
import { useRole } from '../../auth/AuthProvider';
import { BOOKING_SELECT } from '../../hooks/bookings';
import { qk, useStaffName } from '../../hooks/queries';
import {
  autoGrain,
  funnelOf,
  GRAIN_LABELS,
  reasonsOf,
  revenueByCar,
  revenueByMethod,
  revenueByPackage,
  revenueByPeriod,
  sourcesOf,
  type CreatedBooking,
  type Grain,
  type GroupRow,
} from './aggregates';
import { ChartFrame, ColumnChart, HBarChart, SimpleTable, StatTile, type BarDatum } from './charts';
import { DateRangeFilter } from './DateRangeFilter';
import { describeRange, initialRange, rangeBounds, rangeDays, rangeFileSuffix, resolveRange, type DayRange, type RangeBounds, type RangeState } from './range';
import {
  compactRupees,
  csvRupees,
  fetchAll,
  ledgerTotals,
  logExport,
  PAYMENT_CSV_HEADERS,
  PAYMENT_SELECT,
  paymentCsvRows,
  percent,
  type PaymentWithBooking,
} from './reportData';

const hoursFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 });
const fmtHours = (h: number) => `${hoursFmt.format(h)} h`;
const DOC_WINDOW_DAYS = 60;

interface QueryLike<T> {
  data: T | undefined;
  error: unknown;
  isPlaceholderData?: boolean;
}

/** Spinner on first load, an error message on failure, and the previous render dimmed while refetching. */
function Loaded<T>({ query, children }: { query: QueryLike<T>; children: (data: T) => ReactNode }) {
  if (query.error) {
    return (
      <Alert tone="error" title="Couldn't load this report">
        {errorMessage(query.error)} Reload the page to try again.
      </Alert>
    );
  }
  if (query.data === undefined) {
    return (
      <div className="flex justify-center py-8 text-muted" role="status">
        <Spinner size={24} />
        <span className="sr-only">Loading</span>
      </div>
    );
  }
  return <div className={cn('flex flex-col gap-6 transition-opacity', query.isPlaceholderData && 'opacity-60')}>{children(query.data)}</div>;
}

const NoData = ({ children = 'Nothing in this range.' }: { children?: ReactNode }) => (
  <p className="m-0 rounded-xl bg-subtle px-4 py-3 text-[15px] text-muted">{children}</p>
);

// ---------------------------------------------------------------- data

interface ExpiringPaper {
  id: string;
  doc_type: string;
  expiry_date: string;
  status: string;
  car: { id: string; display_name: string; registration_number: string | null } | null;
  type: { label: string } | null;
}

interface PendingKycDoc {
  id: string;
  doc_type: string;
  created_at: string;
  customer: { id: string; full_name: string } | null;
  type: { label: string } | null;
}

function usePaymentsInRange(bounds: RangeBounds | null) {
  return useQuery({
    queryKey: [...qk.payments, 'report', bounds?.fromTs, bounds?.toTs],
    enabled: Boolean(bounds),
    placeholderData: keepPreviousData,
    queryFn: () =>
      fetchAll<PaymentWithBooking>((a, b) =>
        api.from('payments').select(PAYMENT_SELECT).gte('received_at', bounds!.fromTs).lt('received_at', bounds!.toTs).order('received_at').order('id').range(a, b),
      ),
  });
}

function useBookingsCreated(bounds: RangeBounds | null) {
  return useQuery({
    queryKey: [...qk.bookings, 'report-created', bounds?.fromTs, bounds?.toTs],
    enabled: Boolean(bounds),
    placeholderData: keepPreviousData,
    queryFn: () =>
      fetchAll<CreatedBooking>((a, b) =>
        api
          .from('bookings')
          .select('id, status, source, cancel_reason, created_at, booking_events(to_status)')
          // Only the "confirmed" events are embedded: enough to tell if a cancelled booking was confirmed first.
          .eq('booking_events.to_status', 'confirmed')
          .gte('created_at', bounds!.fromTs)
          .lt('created_at', bounds!.toTs)
          .order('created_at')
          .order('id').range(a, b),
      ),
  });
}

function useUtilisation(bounds: RangeBounds | null) {
  return useQuery({
    queryKey: ['reports', 'utilisation', bounds?.fromTs, bounds?.toTs],
    enabled: Boolean(bounds),
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<UtilisationRow[]> => {
      // Hours that haven't happened yet can't be rented, so stop the range at now.
      const toMs = Math.min(Date.parse(bounds!.toTs), Date.now());
      if (toMs <= Date.parse(bounds!.fromTs)) return [];
      const rows = (unwrap(await api.rpc('report_utilisation', { p_from: bounds!.fromTs, p_to: new Date(toMs).toISOString() })) ??
        []) as UtilisationRow[];
      return rows.map((r) => ({
        ...r,
        hours_available: Number(r.hours_available),
        hours_rented: Number(r.hours_rented),
        utilisation: Number(r.utilisation),
      }));
    },
  });
}

// ---------------------------------------------------------------- page

export default function ReportsPage() {
  const now = useNow();
  const today = istDateIso(now);
  const [rangeState, setRangeState] = useState<RangeState>(() => initialRange('this_month'));
  const { range, error: rangeError } = resolveRange(rangeState, today);
  const bounds = range ? rangeBounds(range) : null;

  const payments = usePaymentsInRange(bounds);
  const created = useBookingsCreated(bounds);
  const utilisation = useUtilisation(bounds);

  return (
    <>
      <PageHeader title="Reports" description="Revenue, utilisation, bookings and documents. Dates and times are in IST." />
      <Toolbar>
        <DateRangeFilter value={rangeState} onChange={setRangeState} today={today} />
        {range && (
          <p className="m-0 pb-3 text-[15px] text-muted" aria-live="polite">
            Showing {describeRange(range)}
          </p>
        )}
      </Toolbar>

      {!range || !bounds ? (
        <Alert tone="info">{rangeError ?? 'Choose a date range.'}</Alert>
      ) : (
        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader
              title="Revenue"
              description="Money received in this range: rent and extra charges, minus refunds. Deposits aren't revenue."
            />
            <CardBody>
              <Loaded query={payments}>{(rows) => <RevenueSection payments={rows} range={range} />}</Loaded>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Utilisation"
              description="Hours rented ÷ hours available for each car. Available hours exclude maintenance and stop at the current time."
            />
            <CardBody>
              <Loaded query={utilisation}>{(rows) => <UtilisationSection rows={rows} />}</Loaded>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Bookings funnel" description="Bookings created in this range, and what happened to them." />
            <CardBody>
              <Loaded query={created}>{(rows) => <FunnelSection bookings={rows} />}</Loaded>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Sources" description="Where bookings created in this range came from." />
            <CardBody>
              <Loaded query={created}>{(rows) => <SourcesSection bookings={rows} />}</Loaded>
            </CardBody>
          </Card>

          <DocumentsSection today={today} />

          <ExportSection range={range} bounds={bounds} payments={payments.data} created={created.data} utilisation={utilisation.data} />
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- RPT-01 revenue

const moneyTick = (v: number) => compactRupees(v);

function groupBars(rows: GroupRow[]): BarDatum[] {
  return rows.map((r) => ({
    key: r.key,
    label: r.label,
    value: r.net,
    valueLabel: formatRupees(r.net),
    detail: r.refunded ? `${formatRupees(r.received)} received, ${formatRupees(r.refunded)} refunded` : undefined,
  }));
}

function groupTable(caption: string, first: string, rows: GroupRow[]) {
  return (
    <SimpleTable
      caption={caption}
      headers={[first, 'Received', 'Refunded', 'Net']}
      numeric={[1, 2, 3]}
      rows={rows.map((r) => ({ key: r.key, cells: [r.label, formatRupees(r.received), formatRupees(r.refunded), formatRupees(r.net)] }))}
    />
  );
}

function topSummary(rows: GroupRow[], noun: string): string {
  const withRevenue = rows.filter((r) => r.net !== 0);
  if (withRevenue.length === 0) return 'No revenue in this range.';
  const top = [...withRevenue].sort((a, b) => b.net - a.net)[0];
  return `Highest: ${top.label} with ${formatRupees(top.net)} across ${pluralize(withRevenue.length, noun)}.`;
}

function RevenueSection({ payments, range }: { payments: PaymentWithBooking[]; range: DayRange }) {
  const [grainChoice, setGrainChoice] = useState<Grain | null>(null);
  const grain = grainChoice ?? autoGrain(rangeDays(range));
  const totals = ledgerTotals(payments);
  const periods = revenueByPeriod(payments, range, grain);
  const byCar = revenueByCar(payments);
  const byPackage = revenueByPackage(payments);
  const byMethod = revenueByMethod(payments);
  const best = periods.reduce<(typeof periods)[number] | null>((m, p) => (p.net > (m?.net ?? 0) ? p : m), null);

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Net revenue" value={formatRupees(totals.net)} hint="Rent + extra − refunds" />
        <StatTile label="Rent" value={formatRupees(totals.rent)} />
        <StatTile label="Extra charges" value={formatRupees(totals.extra)} />
        <StatTile label="Refunds" value={formatRupees(totals.refund)} />
      </div>

      <div className="flex flex-col gap-3">
        <div role="group" aria-label="Group revenue by" className="flex flex-wrap gap-2">
          {(['day', 'week', 'month'] as Grain[]).map((g) => (
            <Chip key={g} pressed={grain === g} onClick={() => setGrainChoice(g)}>
              {GRAIN_LABELS[g]}
            </Chip>
          ))}
        </div>
        <ChartFrame
          title={`Net revenue by ${grain}`}
          summary={
            totals.net === 0 && totals.count === 0
              ? 'No payments recorded in this range.'
              : `${formatRupees(totals.net)} net from ${pluralize(totals.count, 'payment')}.${best ? ` Highest ${grain}: ${best.label} (${formatRupees(best.net)}).` : ''}`
          }
          chart={<ColumnChart data={periods.map((p) => ({ key: p.key, label: p.label, tick: p.tick, value: p.net, valueLabel: formatRupees(p.net) }))} formatTick={moneyTick} />}
          table={
            <SimpleTable
              caption={`Revenue by ${grain}`}
              headers={[GRAIN_LABELS[grain], 'Rent', 'Extra', 'Refunds', 'Net']}
              numeric={[1, 2, 3, 4]}
              rows={periods.map((p) => ({
                key: p.key,
                cells: [p.label, formatRupees(p.rent), formatRupees(p.extra), formatRupees(p.refund), formatRupees(p.net)],
              }))}
            />
          }
        />
      </div>

      <ChartFrame
        title="Revenue by car"
        summary={topSummary(byCar, 'car')}
        chart={byCar.length ? <HBarChart data={groupBars(byCar)} formatTick={moneyTick} /> : <NoData>No revenue in this range.</NoData>}
        table={groupTable('Revenue by car', 'Car', byCar)}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartFrame
          title="Revenue by package"
          summary={topSummary(byPackage, 'package')}
          chart={<HBarChart data={groupBars(byPackage)} formatTick={moneyTick} labelWidth={84} />}
          table={groupTable('Revenue by package', 'Package', byPackage)}
        />
        <ChartFrame
          title="Revenue by payment method"
          summary={`${topSummary(byMethod, 'method')} Refunds are taken from the method they were paid with.`}
          chart={<HBarChart data={groupBars(byMethod)} formatTick={moneyTick} labelWidth={112} />}
          table={groupTable('Revenue by payment method', 'Method', byMethod)}
        />
      </div>
    </>
  );
}

// ---------------------------------------------------------------- RPT-02 utilisation

function UtilisationSection({ rows }: { rows: UtilisationRow[] }) {
  if (rows.length === 0) return <NoData>No hours to report yet: this range hasn't started.</NoData>;
  const available = rows.reduce((s, r) => s + r.hours_available, 0);
  const rented = rows.reduce((s, r) => s + r.hours_rented, 0);
  const idle = rows.filter((r) => r.hours_rented <= 0);
  const sorted = [...rows].sort((a, b) => b.utilisation - a.utilisation || a.display_name.localeCompare(b.display_name));
  const pct = (r: UtilisationRow) => Math.round(r.utilisation * 1000) / 10;
  const busiest = sorted[0];

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Fleet utilisation" value={`${percent(rented, available)}%`} hint={`${fmtHours(rented)} of ${fmtHours(available)}`} />
        <StatTile label="Cars counted" value={rows.length} />
        <StatTile label="Idle cars" value={idle.length} hint="No hours rented in this range" />
      </div>
      {idle.length > 0 && (
        <Alert tone="warning" title={`${pluralize(idle.length, 'car')} idle in this range`}>
          {idle.map((r) => r.display_name).join(', ')}
        </Alert>
      )}
      <ChartFrame
        title="Utilisation by car"
        summary={
          busiest && busiest.hours_rented > 0
            ? `Busiest: ${busiest.display_name} at ${pct(busiest)}%. Fleet average ${percent(rented, available)}%.`
            : 'No car was rented in this range.'
        }
        chart={
          <HBarChart
            data={sorted.map((r) => ({
              key: r.car_id,
              label: r.display_name,
              value: pct(r),
              valueLabel: r.hours_rented <= 0 ? '0% · Idle' : `${pct(r)}%`,
              detail: `${fmtHours(r.hours_rented)} rented of ${fmtHours(r.hours_available)}`,
            }))}
            domain={[0, 100]}
            formatTick={(v) => `${v}%`}
          />
        }
        table={
          <SimpleTable
            caption="Utilisation by car"
            headers={['Car', 'Hours rented', 'Hours available', 'Utilisation', 'Note']}
            numeric={[1, 2, 3]}
            rows={sorted.map((r) => ({
              key: r.car_id,
              cells: [r.display_name, fmtHours(r.hours_rented), fmtHours(r.hours_available), `${pct(r)}%`, r.hours_rented <= 0 ? 'Idle' : ''],
            }))}
          />
        }
      />
    </>
  );
}

// ---------------------------------------------------------------- RPT-03 funnel

function FunnelSection({ bookings }: { bookings: CreatedBooking[] }) {
  if (bookings.length === 0) return <NoData>No bookings were created in this range.</NoData>;
  const f = funnelOf(bookings);
  const reasons = reasonsOf(bookings);
  const stages: BarDatum[] = [
    { key: 'requested', label: 'Requested', value: f.requested, valueLabel: String(f.requested) },
    { key: 'confirmed', label: 'Confirmed', value: f.confirmed, valueLabel: `${f.confirmed} · ${percent(f.confirmed, f.requested)}%` },
    { key: 'completed', label: 'Completed', value: f.completed, valueLabel: `${f.completed} · ${percent(f.completed, f.requested)}%` },
  ];
  const outcomes: Array<[string, ReactNode]> = [
    ['Waiting to confirm', f.waiting],
    ['Confirmed or on trip now', f.inProgress],
    ['Rejected', f.rejected],
    ['Cancelled', f.cancelledAfterConfirm ? `${f.cancelled} (${f.cancelledAfterConfirm} after confirming)` : f.cancelled],
    ['No-shows', f.noShow],
  ];

  return (
    <>
      <ChartFrame
        title="Requested → Confirmed → Completed"
        summary={`${percent(f.confirmed, f.requested)}% of ${pluralize(f.requested, 'request')} were confirmed and ${percent(f.completed, f.requested)}% completed (returned or closed).`}
        chart={<HBarChart data={stages} ordinal labelWidth={96} tipSpace={88} />}
        table={
          <SimpleTable
            caption="Bookings funnel"
            headers={['Stage', 'Bookings', 'Share of requests']}
            numeric={[1, 2]}
            rows={stages.map((s) => ({ key: s.key, cells: [s.label, s.value, `${percent(s.value, f.requested)}%`] }))}
          />
        }
      />
      <dl className="m-0 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {outcomes.map(([k, v]) => (
          <div key={k} className="rounded-xl bg-subtle px-3 py-2">
            <dt className="text-sm text-muted">{k}</dt>
            <dd className="m-0 text-lg font-bold">{v}</dd>
          </div>
        ))}
      </dl>
      <section aria-labelledby="reasons-heading" className="flex flex-col gap-3">
        <h3 id="reasons-heading" className="m-0 text-base font-bold">
          Rejection and cancellation reasons
        </h3>
        <SimpleTable
          caption="Rejection and cancellation reasons"
          headers={['Reason', 'Rejected', 'Cancelled', 'Total']}
          numeric={[1, 2, 3]}
          empty="No bookings were rejected or cancelled."
          rows={reasons.map((r) => ({ key: r.key, cells: [r.reason, r.rejected, r.cancelled, r.total] }))}
        />
      </section>
    </>
  );
}

// ---------------------------------------------------------------- RPT-04 sources

function SourcesSection({ bookings }: { bookings: CreatedBooking[] }) {
  if (bookings.length === 0) return <NoData>No bookings were created in this range.</NoData>;
  const rows = sourcesOf(bookings);
  const total = bookings.length;
  const top = [...rows].sort((a, b) => b.bookings - a.bookings)[0];
  return (
    <ChartFrame
      title="Bookings by source"
      summary={`${top.label} brought the most bookings: ${top.bookings} of ${total} (${percent(top.bookings, total)}%).`}
      chart={
        <HBarChart
          data={rows.map((r) => ({
            key: r.key,
            label: r.label,
            value: r.bookings,
            valueLabel: `${r.bookings} · ${percent(r.bookings, total)}%`,
            detail: `${r.confirmed} confirmed, ${r.completed} completed`,
          }))}
          labelWidth={96}
        />
      }
      table={
        <SimpleTable
          caption="Bookings by source"
          headers={['Source', 'Bookings', 'Share', 'Confirmed', 'Completed']}
          numeric={[1, 2, 3, 4]}
          rows={rows.map((r) => ({ key: r.key, cells: [r.label, r.bookings, `${percent(r.bookings, total)}%`, r.confirmed, r.completed] }))}
        />
      }
    />
  );
}

// ---------------------------------------------------------------- RPT-05 documents

function expiryText(expiry: string, today: string): string {
  const d = daysBetween(today, expiry);
  if (d === 0) return 'today';
  return d > 0 ? `in ${pluralize(d, 'day')}` : `${pluralize(-d, 'day')} ago`;
}

function DocumentsSection({ today }: { today: string }) {
  const until = addDaysIso(today, DOC_WINDOW_DAYS);
  const papers = useQuery({
    queryKey: [...qk.documents, 'report-expiring', until],
    queryFn: async () =>
      unwrap(
        await api
          .from('documents')
          .select('id, doc_type, expiry_date, status, car:cars(id, display_name, registration_number), type:document_types(label)')
          .eq('owner_type', 'car')
          .is('deleted_at', null)
          .neq('status', 'superseded')
          .not('expiry_date', 'is', null)
          .lte('expiry_date', until)
          .order('expiry_date'),
      ) as unknown as ExpiringPaper[],
  });
  const pending = useQuery({
    queryKey: [...qk.documents, 'report-pending-kyc'],
    queryFn: async () =>
      unwrap(
        await api
          .from('documents')
          .select('id, doc_type, created_at, customer:customers(id, full_name), type:document_types(label)')
          .eq('owner_type', 'customer')
          .eq('status', 'pending')
          .is('deleted_at', null)
          .order('created_at'),
      ) as unknown as PendingKycDoc[],
  });

  return (
    <Card>
      <CardHeader title="Documents" description={`Not tied to the date range: vehicle papers that expire within ${DOC_WINDOW_DAYS} days (or already have), and customers waiting for document checks.`} />
      <CardBody className="flex flex-col gap-6">
        <section aria-labelledby="papers-heading" className="flex flex-col gap-3">
          <h3 id="papers-heading" className="m-0 text-base font-bold">
            Vehicle papers expiring
          </h3>
          <Loaded query={papers}>
            {(rows) => (
              <SimpleTable
                caption={`Vehicle papers expiring within ${DOC_WINDOW_DAYS} days`}
                headers={['Car', 'Paper', 'Expires', 'Status']}
                empty={`No vehicle papers expire in the next ${DOC_WINDOW_DAYS} days.`}
                rows={rows.map((d) => ({
                  key: d.id,
                  cells: [
                    d.car ? (
                      <Link to={`/admin/fleet/${d.car.id}`} className="font-semibold">
                        {d.car.display_name}
                        {d.car.registration_number && <span className="block text-sm font-normal text-muted">{d.car.registration_number}</span>}
                      </Link>
                    ) : (
                      'Unknown car'
                    ),
                    d.type?.label ?? d.doc_type,
                    <span key="e" className="whitespace-nowrap">
                      {formatIsoDate(d.expiry_date)}
                      <span className="block text-sm text-muted">{expiryText(d.expiry_date, today)}</span>
                    </span>,
                    <ExpiryPill key="s" state={expiryState(d.expiry_date, today)} />,
                  ],
                }))}
              />
            )}
          </Loaded>
        </section>

        <section aria-labelledby="kyc-heading" className="flex flex-col gap-3">
          <h3 id="kyc-heading" className="m-0 text-base font-bold">
            Customers with unverified documents
          </h3>
          <Loaded query={pending}>
            {(rows) => {
              const byCustomer = new Map<string, { id: string; name: string; docs: string[]; oldest: string }>();
              for (const d of rows) {
                if (!d.customer) continue;
                const entry = byCustomer.get(d.customer.id) ?? { id: d.customer.id, name: d.customer.full_name, docs: [], oldest: d.created_at };
                entry.docs.push(d.type?.label ?? d.doc_type);
                if (d.created_at < entry.oldest) entry.oldest = d.created_at;
                byCustomer.set(d.customer.id, entry);
              }
              return (
                <SimpleTable
                  caption="Customers with documents waiting for verification"
                  headers={['Customer', 'Waiting for checks', 'Oldest upload']}
                  empty="No customer documents are waiting for verification."
                  rows={[...byCustomer.values()].map((c) => ({
                    key: c.id,
                    cells: [
                      <Link key="c" to={`/admin/customers/${c.id}`} className="font-semibold">
                        {c.name}
                      </Link>,
                      c.docs.join(', '),
                      formatDateTime(c.oldest),
                    ],
                  }))}
                />
              );
            }}
          </Loaded>
        </section>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------- RPT-06 export

function ExportSection({
  range,
  bounds,
  payments,
  created,
  utilisation,
}: {
  range: DayRange;
  bounds: RangeBounds;
  payments: PaymentWithBooking[] | undefined;
  created: CreatedBooking[] | undefined;
  utilisation: UtilisationRow[] | undefined;
}) {
  const role = useRole();
  const staffName = useStaffName();
  const [busy, setBusy] = useState<'bookings' | 'payments' | 'summary' | null>(null);
  const isOwner = role === 'owner';
  const suffix = rangeFileSuffix(range);

  async function run(kind: 'bookings' | 'payments' | 'summary', job: () => Promise<number>, noun: string) {
    setBusy(kind);
    try {
      const n = await job();
      toast.success(`Downloaded ${pluralize(n, noun)}.`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const exportBookings = () =>
    run(
      'bookings',
      async () => {
        const rows = await fetchAll<BookingWithRefs>((a, b) =>
          api.from('bookings').select(BOOKING_SELECT).gte('pickup_at', bounds.fromTs).lt('pickup_at', bounds.toTs).order('pickup_at').order('id').range(a, b),
        );
        await logExport('bookings.export', 'bookings', { from: range.from, to: range.to, basis: 'pickup', rows: rows.length, mobile_included: isOwner });
        const headers = [
          'Booking code',
          'Status',
          'Source',
          'Car',
          'Registration',
          'Package',
          'Pickup (IST)',
          'Return by (IST)',
          'Price (₹)',
          'Extras (₹)',
          'Discount (₹)',
          'Total (₹)',
          'Paid (₹)',
          'Balance (₹)',
          'Payment status',
          'Customer',
          ...(isOwner ? ['Mobile'] : []),
        ];
        const data: CsvValue[][] = rows.map((b) => [
          b.booking_code,
          BOOKING_STATUS_LABELS[b.status],
          SOURCE_LABELS[b.source],
          b.car?.display_name ?? '',
          b.car?.registration_number ?? '',
          b.package === 'custom' && b.custom_hours ? `${PACKAGE_LABELS.custom} (${b.custom_hours} h)` : PACKAGE_LABELS[b.package],
          formatDateTime(b.pickup_at),
          formatDateTime(b.return_due_at),
          csvRupees(b.price_quoted_paise),
          csvRupees(b.extra_charges_paise),
          csvRupees(b.discount_paise),
          csvRupees(b.total_paise),
          csvRupees(b.paid_paise),
          csvRupees(b.total_paise - b.paid_paise),
          PAYMENT_STATUS_LABELS[b.payment_status],
          b.customer?.full_name ?? '',
          ...(isOwner ? [formatPhone(b.customer?.phone)] : []),
        ]);
        downloadCsv(`ksr-bookings_${suffix}.csv`, headers, data);
        return rows.length;
      },
      'booking',
    );

  const exportPayments = () =>
    run(
      'payments',
      async () => {
        const rows = payments ?? [];
        await logExport('payments.export', 'payments', { from: range.from, to: range.to, rows: rows.length, source: 'reports' });
        downloadCsv(`ksr-payments_${suffix}.csv`, PAYMENT_CSV_HEADERS, paymentCsvRows(rows, staffName));
        return rows.length;
      },
      'payment',
    );

  const exportSummary = () =>
    run(
      'summary',
      async () => {
        const out: CsvValue[][] = [];
        const add = (section: string, item: string, measure: string, value: CsvValue) => out.push([section, item, measure, value]);
        const pays = payments ?? [];
        const t = ledgerTotals(pays);
        add('Revenue', 'Total', 'Rent (₹)', csvRupees(t.rent));
        add('Revenue', 'Total', 'Extra charges (₹)', csvRupees(t.extra));
        add('Revenue', 'Total', 'Refunds (₹)', csvRupees(t.refund));
        add('Revenue', 'Total', 'Net (₹)', csvRupees(t.net));
        add('Revenue', 'Total', 'Deposits held (₹)', csvRupees(t.depositsHeld));
        const grain = autoGrain(rangeDays(range));
        for (const p of revenueByPeriod(pays, range, grain)) add(`Revenue by ${grain}`, p.label, 'Net (₹)', csvRupees(p.net));
        for (const r of revenueByCar(pays)) add('Revenue by car', r.label, 'Net (₹)', csvRupees(r.net));
        for (const r of revenueByPackage(pays)) add('Revenue by package', r.label, 'Net (₹)', csvRupees(r.net));
        for (const r of revenueByMethod(pays)) add('Revenue by payment method', r.label, 'Net (₹)', csvRupees(r.net));
        for (const u of utilisation ?? []) {
          add('Utilisation', u.display_name, 'Hours rented', u.hours_rented);
          add('Utilisation', u.display_name, 'Hours available', u.hours_available);
          add('Utilisation', u.display_name, 'Utilisation (%)', Math.round(u.utilisation * 1000) / 10);
        }
        const bookings = created ?? [];
        const f = funnelOf(bookings);
        add('Bookings funnel', 'Requested', 'Bookings', f.requested);
        add('Bookings funnel', 'Confirmed', 'Bookings', f.confirmed);
        add('Bookings funnel', 'Completed', 'Bookings', f.completed);
        add('Bookings funnel', 'Rejected', 'Bookings', f.rejected);
        add('Bookings funnel', 'Cancelled', 'Bookings', f.cancelled);
        add('Bookings funnel', 'No-show', 'Bookings', f.noShow);
        for (const r of reasonsOf(bookings)) add('Rejection and cancellation reasons', r.reason, 'Bookings', r.total);
        for (const s of sourcesOf(bookings)) add('Sources', s.label, 'Bookings', s.bookings);
        await logExport('report.export', 'reports', { from: range.from, to: range.to, rows: out.length });
        downloadCsv(`ksr-report-summary_${suffix}.csv`, ['Section', 'Item', 'Measure', 'Value'], out);
        return out.length;
      },
      'row',
    );

  const icon = <Download size={18} aria-hidden="true" />;
  return (
    <Card>
      <CardHeader title="Export" description={`CSV files for ${describeRange(range)}. Every export is recorded in the audit log.`} />
      <CardBody className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" icon={icon} onClick={exportBookings} loading={busy === 'bookings'} disabled={busy !== null}>
            Download bookings
          </Button>
          <Button variant="secondary" icon={icon} onClick={exportPayments} loading={busy === 'payments'} disabled={busy !== null || !payments}>
            Download payments
          </Button>
          <Button
            variant="secondary"
            icon={icon}
            onClick={exportSummary}
            loading={busy === 'summary'}
            disabled={busy !== null || !payments || !created || !utilisation}
          >
            Download report summary
          </Button>
        </div>
        <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[15px] text-muted">
          <li>Bookings are those with a pickup in this range; payments are those received in it.</li>
          <li>Files never include licence, Aadhaar or other document numbers, or any document images.</li>
          <li>{isOwner ? 'Customer mobile numbers are included because you are the Owner.' : 'Customer names are included; mobile numbers are left out.'}</li>
        </ul>
      </CardBody>
    </Card>
  );
}
