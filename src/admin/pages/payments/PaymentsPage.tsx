// /admin/payments (PAY-01..03, Owner and Manager): the payments ledger for an IST date range,
// totals per type, an audited CSV export (no KYC data), and bookings with money outstanding.
import { useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Download } from 'lucide-react';
import {
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  PAYMENT_TYPE_LABELS,
  PAYMENT_TYPES,
  PACKAGE_LABELS,
  REFUND_TYPES,
  type BookingStatus,
  type PaymentMethod,
  type PaymentType,
} from '@shared/constants.ts';
import { displayStatus } from '@shared/booking.ts';
import { Badge, BookingCode, PaymentPill, StatusPill } from '@/components/ui/Badges';
import { Button } from '@/components/ui/Button';
import { Alert, Field, Select } from '@/components/ui/Field';
import { Card, CardBody, CardHeader, DataTable, EmptyState, PageHeader, Toolbar, type Column } from '@/components/ui/Layout';
import { PageSpinner } from '@/components/ui/Spinner';
import { api } from '@/integrations/api/client';
import { cn } from '@/lib/cn';
import { downloadCsv } from '@/lib/csv';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatRupees, istDateIso, pluralize } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import type { BookingWithRefs } from '@/types/db';
import { BOOKING_SELECT } from '../../hooks/bookings';
import { qk, useStaffDirectory, useStaffName } from '../../hooks/queries';
import { StatTile } from '../reports/charts';
import { DateRangeFilter } from '../reports/DateRangeFilter';
import { describeRange, initialRange, rangeBounds, rangeFileSuffix, resolveRange, type RangeState } from '../reports/range';
import {
  fetchAll,
  ledgerTotals,
  logExport,
  PAYMENT_CSV_HEADERS,
  PAYMENT_SELECT,
  paymentCsvRows,
  type PaymentWithBooking,
} from '../reports/reportData';

const OUTSTANDING_STATUSES: BookingStatus[] = ['confirmed', 'active', 'returned', 'closed'];

const isRefund = (t: PaymentType) => REFUND_TYPES.includes(t);

export default function PaymentsPage() {
  const now = useNow();
  const today = istDateIso(now);
  const staffName = useStaffName();
  const { data: staff = [] } = useStaffDirectory();

  const [rangeState, setRangeState] = useState<RangeState>(() => initialRange('this_month'));
  const [type, setType] = useState<PaymentType | ''>('');
  const [method, setMethod] = useState<PaymentMethod | ''>('');
  const [receivedBy, setReceivedBy] = useState('');
  const [exporting, setExporting] = useState(false);

  const { range, error: rangeError } = resolveRange(rangeState, today);
  const bounds = range ? rangeBounds(range) : null;

  const ledger = useQuery({
    queryKey: [...qk.payments, 'ledger', bounds?.fromTs, bounds?.toTs, type, method, receivedBy],
    enabled: Boolean(bounds),
    placeholderData: keepPreviousData,
    queryFn: () =>
      fetchAll<PaymentWithBooking>((a, b) => {
        let q = api.from('payments').select(PAYMENT_SELECT).gte('received_at', bounds!.fromTs).lt('received_at', bounds!.toTs);
        if (type) q = q.eq('type', type);
        if (method) q = q.eq('method', method);
        if (receivedBy) q = q.eq('received_by', receivedBy);
        return q.order('received_at', { ascending: false }).order('id').range(a, b);
      }),
  });

  const rows = ledger.data ?? [];
  const totals = ledgerTotals(rows);
  const filtersActive = Boolean(type || method || receivedBy);

  async function exportCsv() {
    if (!range) return;
    setExporting(true);
    try {
      await logExport('payments.export', 'payments', {
        from: range.from,
        to: range.to,
        type: type || null,
        method: method || null,
        received_by: receivedBy || null,
        rows: rows.length,
        source: 'payments',
      });
      downloadCsv(`ksr-payments_${rangeFileSuffix(range)}.csv`, PAYMENT_CSV_HEADERS, paymentCsvRows(rows, staffName));
      toast.success(`Downloaded ${pluralize(rows.length, 'payment')}.`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setExporting(false);
    }
  }

  const columns: Column<PaymentWithBooking>[] = [
    { key: 'when', header: 'Received', cell: (p) => <span className="whitespace-nowrap">{formatDateTime(p.received_at)}</span> },
    {
      key: 'booking',
      header: 'Booking',
      hideOnMobile: true,
      cell: (p) =>
        p.booking ? (
          <Link to={`/admin/bookings/${p.booking.booking_code}`} className="whitespace-nowrap">
            <BookingCode code={p.booking.booking_code} status={p.booking.status} />
          </Link>
        ) : (
          '—'
        ),
    },
    {
      key: 'car',
      header: 'Car',
      cell: (p) => (
        <>
          {p.booking?.car?.display_name ?? '—'}
          {p.booking && <span className="block text-sm text-muted">{PACKAGE_LABELS[p.booking.package]}</span>}
        </>
      ),
    },
    { key: 'customer', header: 'Customer', cell: (p) => p.booking?.customer?.full_name ?? '—' },
    {
      key: 'type',
      header: 'Type',
      cell: (p) => <Badge tone={isRefund(p.type) ? 'red' : p.type === 'deposit' ? 'blue' : 'outline'}>{PAYMENT_TYPE_LABELS[p.type]}</Badge>,
    },
    { key: 'method', header: 'Method', cell: (p) => PAYMENT_METHOD_LABELS[p.method] },
    {
      key: 'amount',
      header: 'Amount',
      className: 'text-right whitespace-nowrap tabular-nums',
      cell: (p) => (
        <span className={cn('font-semibold', isRefund(p.type) && 'text-danger')}>
          {isRefund(p.type) ? `−${formatRupees(p.amount_paise)}` : formatRupees(p.amount_paise)}
        </span>
      ),
    },
    {
      key: 'ref',
      header: 'Reference',
      cell: (p) => (
        <>
          {p.reference || '—'}
          {p.note && <span className="block max-w-56 text-sm text-muted">{p.note}</span>}
        </>
      ),
    },
    { key: 'by', header: 'Received by', cell: (p) => staffName(p.received_by) },
  ];

  return (
    <>
      <PageHeader
        title="Payments"
        description="Every payment, deposit and refund recorded against bookings. Record new payments from the booking."
        actions={
          <Button
            variant="secondary"
            icon={<Download size={18} aria-hidden="true" />}
            onClick={exportCsv}
            loading={exporting}
            disabled={!range || !ledger.data || rows.length === 0}
          >
            Download CSV
          </Button>
        }
      />

      <Toolbar>
        <DateRangeFilter value={rangeState} onChange={setRangeState} today={today} />
        <Field label="Type" className="w-[calc(50%-0.375rem)] sm:w-44">
          <Select value={type} onChange={(e) => setType(e.target.value as PaymentType | '')}>
            <option value="">All types</option>
            {PAYMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {PAYMENT_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Method" className="w-[calc(50%-0.375rem)] sm:w-44">
          <Select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod | '')}>
            <option value="">All methods</option>
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {PAYMENT_METHOD_LABELS[m]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Received by" className="w-full sm:w-52">
          <Select value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)}>
            <option value="">Anyone</option>
            {staff.map((s) => (
              <option key={s.user_id} value={s.user_id}>
                {s.full_name}
                {s.active ? '' : ' (inactive)'}
              </option>
            ))}
          </Select>
        </Field>
        {filtersActive && (
          <Button
            variant="ghost"
            onClick={() => {
              setType('');
              setMethod('');
              setReceivedBy('');
            }}
          >
            Clear filters
          </Button>
        )}
      </Toolbar>

      {!range ? (
        <Alert tone="info">{rangeError ?? 'Choose a date range.'}</Alert>
      ) : ledger.error ? (
        <Alert tone="error" title="Couldn't load payments">
          {errorMessage(ledger.error)} Reload the page to try again.
        </Alert>
      ) : !ledger.data ? (
        <PageSpinner label="Loading payments" />
      ) : (
        <div className={cn('flex flex-col gap-5 transition-opacity', ledger.isPlaceholderData && 'opacity-60')}>
          <section aria-label="Totals" className="flex flex-col gap-2">
            <p className="m-0 text-[15px] text-muted" aria-live="polite">
              {pluralize(totals.count, 'payment')} · {describeRange(range)}
              {filtersActive ? ' · filtered' : ''}
            </p>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              <StatTile label="Net revenue" value={formatRupees(totals.net)} hint="Rent + extra − refunds" />
              <StatTile label="Rent" value={formatRupees(totals.rent)} />
              <StatTile label="Extra charges" value={formatRupees(totals.extra)} />
              <StatTile label="Refunds" value={formatRupees(totals.refund)} />
              <StatTile label="Deposits taken" value={formatRupees(totals.deposit)} hint={`${formatRupees(totals.deposit_refund)} returned`} />
              <StatTile label="Deposits held" value={formatRupees(totals.depositsHeld)} hint="Deposits − deposit refunds" />
            </div>
          </section>

          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(p) => p.id}
            caption={`Payments, ${describeRange(range)}`}
            mobileTitle={(p) =>
              p.booking ? (
                <Link to={`/admin/bookings/${p.booking.booking_code}`}>
                  <BookingCode code={p.booking.booking_code} status={p.booking.status} />
                </Link>
              ) : null
            }
            empty={
              <EmptyState title="No payments in this range">
                {filtersActive ? 'Try clearing the filters or choosing other dates.' : 'Try other dates.'}
              </EmptyState>
            }
          />
        </div>
      )}

      <Outstanding />
    </>
  );
}

// ---------------------------------------------------------------- outstanding balances

function Outstanding() {
  const now = useNow();
  const query = useQuery({
    queryKey: [...qk.bookings, 'outstanding'],
    queryFn: async () => {
      // PostgREST can't compare two columns, so narrow on the server and finish here.
      const rows = await fetchAll<BookingWithRefs>((a, b) =>
        api
          .from('bookings')
          .select(BOOKING_SELECT)
          .in('status', OUTSTANDING_STATUSES)
          .or('payment_status.neq.paid,deposit_received_paise.gt.0')
          .order('return_due_at')
          .order('id').range(a, b),
      );
      return rows.filter((b) => b.total_paise - b.paid_paise > 0 || b.deposit_received_paise - b.deposit_refunded_paise > 0);
    },
  });

  const rows = query.data ?? [];
  const toCollect = rows.reduce((s, b) => s + Math.max(0, b.total_paise - b.paid_paise), 0);
  const held = rows.reduce((s, b) => s + Math.max(0, b.deposit_received_paise - b.deposit_refunded_paise), 0);

  const columns: Column<BookingWithRefs>[] = [
    {
      key: 'code',
      header: 'Booking',
      hideOnMobile: true,
      cell: (b) => (
        <Link to={`/admin/bookings/${b.booking_code}`}>
          <BookingCode code={b.booking_code} status={b.status} />
        </Link>
      ),
    },
    { key: 'status', header: 'Status', cell: (b) => <StatusPill status={displayStatus(b, now)} /> },
    { key: 'customer', header: 'Customer', cell: (b) => b.customer?.full_name ?? '—' },
    { key: 'car', header: 'Car', cell: (b) => b.car?.display_name ?? '—' },
    { key: 'return', header: 'Return by', hideOnMobile: true, cell: (b) => <span className="whitespace-nowrap">{formatDateTime(b.return_due_at)}</span> },
    { key: 'total', header: 'Total', className: 'text-right tabular-nums whitespace-nowrap', cell: (b) => formatRupees(b.total_paise) },
    { key: 'paid', header: 'Paid', className: 'text-right tabular-nums whitespace-nowrap', cell: (b) => formatRupees(b.paid_paise) },
    {
      key: 'balance',
      header: 'Balance',
      className: 'text-right tabular-nums whitespace-nowrap',
      cell: (b) => {
        const due = b.total_paise - b.paid_paise;
        return due > 0 ? <span className="font-semibold">{formatRupees(due)}</span> : <span className="text-muted">None</span>;
      },
    },
    {
      key: 'deposit',
      header: 'Deposit held',
      className: 'text-right tabular-nums whitespace-nowrap',
      cell: (b) => {
        const d = b.deposit_received_paise - b.deposit_refunded_paise;
        return d > 0 ? formatRupees(d) : <span className="text-muted">None</span>;
      },
    },
    { key: 'pay', header: 'Payment', cell: (b) => <PaymentPill status={b.payment_status} /> },
  ];

  return (
    <Card className="mt-6">
      <CardHeader
        title="Outstanding balances"
        description={
          query.data
            ? `${pluralize(rows.length, 'booking')} · ${formatRupees(toCollect)} to collect · ${formatRupees(held)} in deposits still held`
            : 'Confirmed, active, returned and closed bookings with money still owed or a deposit not yet returned.'
        }
      />
      <CardBody>
        {query.error ? (
          <Alert tone="error" title="Couldn't load outstanding balances">
            {errorMessage(query.error)} Reload the page to try again.
          </Alert>
        ) : !query.data ? (
          <PageSpinner label="Loading outstanding balances" />
        ) : (
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(b) => b.id}
            caption="Bookings with an outstanding balance or a deposit held"
            mobileTitle={(b) => (
              <Link to={`/admin/bookings/${b.booking_code}`}>
                <BookingCode code={b.booking_code} status={b.status} />
              </Link>
            )}
            empty={<EmptyState title="Nothing outstanding">Every booking is paid and no deposits are held.</EmptyState>}
          />
        )}
      </CardBody>
    </Card>
  );
}
