// Customer detail: bookings, payments and consents (CUS-03, DP-02). Read-only.
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { PAYMENT_METHOD_LABELS, PAYMENT_TYPE_LABELS, REFUND_TYPES } from '@shared/constants.ts';
import { displayStatus } from '@shared/booking.ts';
import { Badge, BookingCode, PaymentPill, StatusPill } from '@/components/ui/Badges';
import { Alert } from '@/components/ui/Field';
import { Card, CardBody, CardHeader, DataTable, EmptyState, type Column } from '@/components/ui/Layout';
import { Spinner } from '@/components/ui/Spinner';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatRupees, formatWhen, pluralize } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import type { Consent, Payment } from '@/types/db';
import { CONSENT_CHANNEL_LABELS, CONSENT_PURPOSE_LABELS, type CustomerBooking } from './customerData';

interface Loadable<T> {
  data: T[] | undefined;
  isLoading: boolean;
  error: unknown;
}

function Body<T>({ q, children }: { q: Loadable<T>; children: (rows: T[]) => ReactNode }) {
  if (q.isLoading) {
    return (
      <div className="flex justify-center p-6">
        <Spinner label="Loading" />
      </div>
    );
  }
  if (q.error) return <Alert className="m-4">{errorMessage(q.error)}</Alert>;
  return <>{children(q.data ?? [])}</>;
}

export function BookingsCard({ bookings }: { bookings: Loadable<CustomerBooking> }) {
  const now = useNow();
  const navigate = useNavigate();
  const columns: Column<CustomerBooking>[] = [
    {
      key: 'code',
      header: 'Booking',
      hideOnMobile: true,
      cell: (b) => (
        <Link to={`/admin/bookings/${b.booking_code}`} onClick={(e) => e.stopPropagation()} className="text-ink">
          <BookingCode code={b.booking_code} status={displayStatus(b, now)} />
        </Link>
      ),
    },
    { key: 'status', header: 'Status', cell: (b) => <StatusPill status={displayStatus(b, now)} /> },
    { key: 'car', header: 'Car', cell: (b) => b.car?.display_name ?? '—' },
    { key: 'pickup', header: 'Pickup', cell: (b) => <span className="whitespace-nowrap">{formatWhen(b.pickup_at)}</span> },
    { key: 'total', header: 'Total', className: 'text-right', cell: (b) => formatRupees(b.total_paise) },
    { key: 'payment', header: 'Payment', cell: (b) => <PaymentPill status={b.payment_status} /> },
  ];
  const count = bookings.data?.length ?? 0;
  return (
    <Card>
      <CardHeader title="Bookings" description={bookings.data ? pluralize(count, 'booking') : undefined} />
      <Body q={bookings}>
        {(rows) => (
          <CardBody>
            <DataTable
              rows={rows}
              columns={columns}
              rowKey={(b) => b.id}
              caption="Bookings for this customer"
              onRowClick={(b) => navigate(`/admin/bookings/${b.booking_code}`)}
              mobileTitle={(b) => (
                <Link to={`/admin/bookings/${b.booking_code}`} onClick={(e) => e.stopPropagation()} className="inline-flex min-h-11 items-center text-ink">
                  <BookingCode code={b.booking_code} status={displayStatus(b, now)} />
                </Link>
              )}
              empty={<EmptyState title="No bookings yet" />}
            />
          </CardBody>
        )}
      </Body>
    </Card>
  );
}

export function PaymentsCard({ payments, bookings }: { payments: Loadable<Payment>; bookings: CustomerBooking[] }) {
  const codeOf = new Map(bookings.map((b) => [b.id, b.booking_code]));
  const columns: Column<Payment>[] = [
    { key: 'when', header: 'Received', hideOnMobile: true, cell: (p) => <span className="whitespace-nowrap">{formatDateTime(p.received_at)}</span> },
    {
      key: 'booking',
      header: 'Booking',
      cell: (p) => {
        const code = codeOf.get(p.booking_id);
        return code ? (
          <Link to={`/admin/bookings/${code}`} className="font-mono text-[14px] font-semibold text-ink">
            {code}
          </Link>
        ) : (
          '—'
        );
      },
    },
    { key: 'type', header: 'Type', cell: (p) => PAYMENT_TYPE_LABELS[p.type] },
    { key: 'method', header: 'Method', cell: (p) => PAYMENT_METHOD_LABELS[p.method] },
    {
      key: 'amount',
      header: 'Amount',
      className: 'text-right',
      cell: (p) => (
        <span className="font-semibold whitespace-nowrap">
          {REFUND_TYPES.includes(p.type) ? formatRupees(-Math.abs(p.amount_paise)) : formatRupees(p.amount_paise)}
        </span>
      ),
    },
    { key: 'reference', header: 'Reference', hideOnMobile: true, cell: (p) => p.reference || '—' },
  ];
  // Payments only exist for bookings; with no bookings there is nothing to load.
  const q: Loadable<Payment> = bookings.length === 0 ? { data: [], isLoading: false, error: null } : payments;
  return (
    <Card>
      <CardHeader title="Payments" />
      <Body q={q}>
        {(rows) => (
          <CardBody>
            <DataTable
              rows={rows}
              columns={columns}
              rowKey={(p) => p.id}
              caption="Payments for this customer's bookings"
              mobileTitle={(p) => <span className="font-semibold">{formatDateTime(p.received_at)}</span>}
              empty={<EmptyState title="No payments recorded" />}
            />
          </CardBody>
        )}
      </Body>
    </Card>
  );
}

export function ConsentsCard({ consents }: { consents: Loadable<Consent> }) {
  const columns: Column<Consent>[] = [
    { key: 'purpose', header: 'Purpose', hideOnMobile: true, cell: (c) => <span className="font-semibold">{CONSENT_PURPOSE_LABELS[c.purpose]}</span> },
    { key: 'version', header: 'Notice version', cell: (c) => c.notice_version },
    { key: 'channel', header: 'Given via', cell: (c) => CONSENT_CHANNEL_LABELS[c.channel] },
    { key: 'granted', header: 'Given on', cell: (c) => <span className="whitespace-nowrap">{formatDateTime(c.granted_at)}</span> },
    {
      key: 'withdrawn',
      header: 'Withdrawn',
      cell: (c) => (c.withdrawn_at ? <Badge tone="grey">{formatDateTime(c.withdrawn_at)}</Badge> : <span className="text-muted">No</span>),
    },
  ];
  return (
    <Card>
      <CardHeader title="Consents" description="What the customer agreed to, and which version of the privacy notice they saw." />
      <Body q={consents}>
        {(rows) => (
          <CardBody>
            <DataTable
              rows={rows}
              columns={columns}
              rowKey={(c) => c.id}
              caption="Consents"
              mobileTitle={(c) => <span className="font-semibold">{CONSENT_PURPOSE_LABELS[c.purpose]}</span>}
              empty={<EmptyState title="No consents recorded" />}
            />
          </CardBody>
        )}
      </Body>
    </Card>
  );
}
