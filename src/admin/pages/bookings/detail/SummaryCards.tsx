// BKA-03 summary: customer, car, trip and money (PAY-02) on one screen.
import { Link } from 'react-router';
import { AlertTriangle, ShieldCheck } from 'lucide-react';
import { lateHours } from '@shared/booking.ts';
import { IDENTITY_METHOD_LABELS } from '@shared/constants.ts';
import type { BookingRules } from '@shared/settings.ts';
import { Badge, PaymentPill } from '@/components/ui/Badges';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Field';
import { Card, CardBody, CardHeader, KeyValue } from '@/components/ui/Layout';
import { formatDateTime, formatDuration, formatIsoDate, formatPhone, formatRelativeDay, formatRupees, telHref } from '@/lib/format';
import type { BookingWithRefs } from '@/types/db';
import { useStaffName } from '@/admin/hooks/queries';
import type { CustomerDetail } from './api';
import { ledgerOf, packageLabel } from './helpers';

export function CustomerCard({
  booking,
  customer,
  om,
  onVerifyIdentity,
}: {
  booking: BookingWithRefs;
  customer: CustomerDetail | null | undefined;
  om: boolean;
  onVerifyIdentity: () => void;
}) {
  const staffName = useStaffName();
  const c = booking.customer;
  if (!c) {
    return (
      <Card>
        <CardHeader title="Customer" />
        <CardBody>
          <p className="m-0 text-muted">Customer details are visible on the day of the booking.</p>
        </CardBody>
      </Card>
    );
  }
  const verified = customer?.identity_verified ?? c.identity_verified;
  const blocked = customer?.blocked ?? c.blocked;
  return (
    <Card>
      <CardHeader
        title="Customer"
        actions={
          om && (
            <Link to={`/admin/customers/${c.id}`} className="inline-flex min-h-11 items-center font-semibold">
              Open customer
            </Link>
          )
        }
      />
      <CardBody className="flex flex-col gap-4">
        {blocked && (
          <Alert title="Blocked customer">{customer?.block_reason ? `Reason: ${customer.block_reason}` : 'Check with the Owner before handing over a car.'}</Alert>
        )}
        <KeyValue
          items={[
            ['Name', c.full_name],
            ['Mobile', c.phone ? <a href={telHref(c.phone)}>{formatPhone(c.phone)}</a> : '—'],
            customer?.email ? ['Email', customer.email] : null,
            ['Licence expiry', customer?.dl_expiry ? formatIsoDate(customer.dl_expiry) : 'Not recorded'],
          ]}
        />
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-subtle px-3 py-2.5">
          {verified ? (
            <span className="flex items-start gap-2">
              <ShieldCheck size={20} className="mt-0.5 shrink-0 text-emerald-700" aria-hidden="true" />
              <span>
                <span className="block font-semibold">Identity verified</span>
                {customer?.identity_method && (
                  <span className="block text-sm text-muted">
                    {IDENTITY_METHOD_LABELS[customer.identity_method]}
                    {customer.identity_verified_at && ` · ${staffName(customer.identity_verified_by)}, ${formatDateTime(customer.identity_verified_at)}`}
                  </span>
                )}
              </span>
            </span>
          ) : (
            <>
              <span className="flex items-center gap-2 font-semibold text-amber-900">
                <AlertTriangle size={20} aria-hidden="true" /> Identity not verified
              </span>
              <Button size="sm" variant="secondary" icon={<ShieldCheck size={16} aria-hidden="true" />} onClick={onVerifyIdentity}>
                Verify identity
              </Button>
            </>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

export function CarCard({ booking, om }: { booking: BookingWithRefs; om: boolean }) {
  const car = booking.car;
  return (
    <Card>
      <CardHeader
        title="Car"
        actions={
          om && (
            <Link to={`/admin/fleet/${booking.car_id}`} className="inline-flex min-h-11 items-center font-semibold">
              Open car
            </Link>
          )
        }
      />
      <CardBody>
        <p className="m-0 text-lg font-bold">{car?.display_name ?? 'Car not found'}</p>
        {car?.registration_number ? (
          <p className="m-0 mt-2">
            <span className="sr-only">Registration </span>
            <span className="inline-block rounded-md border-2 border-ink bg-plate px-2.5 py-0.5 font-mono font-bold tracking-wider text-ink">
              {car.registration_number}
            </span>
          </p>
        ) : (
          <p className="m-0 mt-1 text-sm text-muted">No registration number on file.</p>
        )}
      </CardBody>
    </Card>
  );
}

export function TripCard({ booking, now, rules }: { booking: BookingWithRefs; now: number; rules: BookingRules }) {
  const due = new Date(booking.return_due_at).getTime();
  const overdueMs = booking.status === 'active' ? now - due : 0;
  const returnedLateMs = booking.actual_return_at ? new Date(booking.actual_return_at).getTime() - due : 0;
  const chargeable = booking.actual_return_at ? lateHours(booking.return_due_at, booking.actual_return_at, rules.late_grace_minutes) : 0;
  return (
    <Card>
      <CardHeader title="Trip" />
      <CardBody className="flex flex-col gap-4">
        <KeyValue
          items={[
            ['Package', packageLabel(booking)],
            ['Pickup', formatRelativeDay(booking.pickup_at, now)],
            ['Return by', formatRelativeDay(booking.return_due_at, now)],
            booking.actual_pickup_at ? ['Picked up', formatDateTime(booking.actual_pickup_at)] : null,
            booking.actual_return_at ? ['Returned', formatDateTime(booking.actual_return_at)] : null,
          ]}
        />
        <div aria-live="polite">
          {overdueMs > 0 && (
            <Alert title={`Overdue by ${formatDuration(overdueMs)}`}>
              {overdueMs > rules.late_grace_minutes * 60_000
                ? `Late fee applies after the ${rules.late_grace_minutes}-minute grace period.`
                : `Still within the ${rules.late_grace_minutes}-minute grace period.`}
            </Alert>
          )}
          {returnedLateMs > 60_000 && (
            <p className="m-0 font-semibold text-danger">
              Returned {formatDuration(returnedLateMs)} late
              {chargeable > 0 ? ` (${chargeable} chargeable h after the grace period)` : ' (within the grace period)'}.
            </p>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

export function MoneyCard({ booking }: { booking: BookingWithRefs }) {
  const l = ledgerOf(booking);
  return (
    <Card>
      <CardHeader title="Money" actions={<PaymentPill status={booking.payment_status} />} />
      <CardBody className="flex flex-col gap-3">
        <dl className="m-0 flex flex-col gap-1.5 text-[15px]" aria-live="polite">
          <Line label="Price quoted" value={formatRupees(booking.price_quoted_paise)} />
          <Line label="Extra charges" value={formatRupees(booking.extra_charges_paise)} />
          {booking.discount_paise > 0 && <Line label="Discount" value={`− ${formatRupees(booking.discount_paise)}`} />}
          <Line label="Total due" value={formatRupees(booking.total_paise)} strong />
          <Line label="Paid" value={formatRupees(booking.paid_paise)} />
          {booking.refunded_paise > 0 && <Line label="Refunded" value={formatRupees(booking.refunded_paise)} />}
          <Line
            label={l.balance < 0 ? 'Overpaid' : 'Balance'}
            value={formatRupees(Math.abs(l.balance))}
            strong
            tone={l.balance > 0 ? 'danger' : undefined}
          />
        </dl>
        <div className="rounded-xl bg-subtle px-3 py-2.5">
          <p className="m-0 mb-1 flex flex-wrap items-center gap-2 font-semibold">
            Security deposit
            {l.depositHeld > 0 && <Badge tone="blue">Held {formatRupees(l.depositHeld)}</Badge>}
          </p>
          <dl className="m-0 flex flex-col gap-1 text-[15px]">
            <Line label="Required" value={formatRupees(booking.deposit_paise)} />
            <Line label="Received" value={formatRupees(booking.deposit_received_paise)} />
            <Line label="Refunded" value={formatRupees(booking.deposit_refunded_paise)} />
          </dl>
        </div>
      </CardBody>
    </Card>
  );
}

function Line({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: 'danger' }) {
  return (
    <div className={strong ? 'flex justify-between gap-3 border-t border-line-card pt-1.5 font-bold' : 'flex justify-between gap-3'}>
      <dt className={strong ? undefined : 'text-muted'}>{label}</dt>
      <dd className={tone === 'danger' ? 'm-0 text-danger' : 'm-0'}>{value}</dd>
    </div>
  );
}
