// Dashboard cards (DSH-01..06). Each card loads its own data so one slow query never blocks the rest.
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { MAINTENANCE_REASON_LABELS } from '@shared/constants.ts';
import { expiryState } from '@shared/documents.ts';
import { Badge, ExpiryPill, FlagPills } from '@/components/ui/Badges';
import { ButtonLink } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Layout';
import { cn } from '@/lib/cn';
import { formatClock, formatDuration, formatIsoDate, formatRelativeDay, formatRupees, istTime, pluralize } from '@/lib/format';
import type { Car } from '@/types/db';
import { useCars, useDocumentTypes } from '../../hooks/queries';
import { BookingLine, QueryState, SubHeading } from './BookingLine';
import {
  classifyFleet,
  FLEET_STATE_LABELS,
  monthBounds,
  useActiveBookings,
  useCarPaperAlerts,
  useFlaggedBookings,
  useMonthStats,
  useOpenMaintenance,
  usePendingKyc,
  useRequestedBookings,
  useTodayBookings,
  type FleetEntry,
  type FleetState,
  type PendingKycDoc,
} from './useDashboard';

const clockOf = (iso: string) => formatClock(istTime(iso));
const ul = 'm-0 list-none p-0';

function CardLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <ButtonLink to={to} variant="ghost" size="sm">
      {children}
    </ButtonLink>
  );
}

// ------------------------------------------------------------------ DSH-01

export function NeedsActionCard({ now }: { now: number }) {
  const requested = useRequestedBookings(true);
  const flagged = useFlaggedBookings(true);
  return (
    <Card>
      <CardHeader title="Needs action" description="New requests to confirm or reject, and flagged bookings to check before pickup." />
      <CardBody className="flex flex-col gap-5">
        <div>
          <SubHeading count={requested.data?.length} tone="amber">
            New requests
          </SubHeading>
          <QueryState query={requested} empty="No new requests.">
            {(rows) => (
              <ul className={ul}>
                {rows.map((b) => (
                  <BookingLine
                    key={b.id}
                    booking={b}
                    now={now}
                    meta={<FlagPills flags={b.flags} />}
                    detail={`Pickup ${formatRelativeDay(b.pickup_at, now)} · waiting ${formatDuration(now - new Date(b.created_at).getTime())}`}
                  />
                ))}
              </ul>
            )}
          </QueryState>
        </div>
        <div>
          <SubHeading count={flagged.data?.length} tone="red">
            Flagged
          </SubHeading>
          <QueryState query={flagged} empty="No confirmed bookings are flagged.">
            {(rows) => (
              <ul className={ul}>
                {rows.map((b) => (
                  <BookingLine
                    key={b.id}
                    booking={b}
                    now={now}
                    meta={<FlagPills flags={b.flags} />}
                    detail={`Pickup ${formatRelativeDay(b.pickup_at, now)}`}
                  />
                ))}
              </ul>
            )}
          </QueryState>
        </div>
      </CardBody>
    </Card>
  );
}

// ------------------------------------------------------------------ DSH-02

export function TodayCard({ now, todayIso }: { now: number; todayIso: string }) {
  const today = useTodayBookings(todayIso);
  return (
    <Card>
      <CardHeader title="Today" description="Pickups and returns, in IST." actions={<CardLink to="/admin/bookings">All bookings</CardLink>} />
      <CardBody className="flex flex-col gap-5">
        <div>
          <SubHeading count={today.data?.pickups.length}>Pickups</SubHeading>
          <QueryState query={today} isEmpty={(d) => d.pickups.length === 0} empty="No pickups today.">
            {(d) => (
              <ul className={ul}>
                {d.pickups.map((b) => (
                  <BookingLine key={b.id} booking={b} now={now} lead={clockOf(b.pickup_at)} />
                ))}
              </ul>
            )}
          </QueryState>
        </div>
        <div>
          <SubHeading count={today.data?.returns.length}>Returns</SubHeading>
          <QueryState query={today} isEmpty={(d) => d.returns.length === 0} empty="No returns due today.">
            {(d) => (
              <ul className={ul}>
                {d.returns.map((b) => (
                  <BookingLine key={b.id} booking={b} now={now} lead={clockOf(b.return_due_at)} />
                ))}
              </ul>
            )}
          </QueryState>
        </div>
      </CardBody>
    </Card>
  );
}

// ------------------------------------------------------------------ DSH-03

export function OverdueCard({ now }: { now: number }) {
  const active = useActiveBookings();
  const overdue = (active.data ?? []).filter((b) => new Date(b.return_due_at).getTime() < now);
  return (
    <Card>
      <CardHeader
        title="Overdue"
        description="Cars on a trip that are past their return time."
        actions={active.data ? <Badge tone={overdue.length ? 'red' : 'grey'}>{pluralize(overdue.length, 'car')}</Badge> : undefined}
      />
      <CardBody>
        <QueryState
          query={{
            data: active.data ? overdue : undefined,
            isPending: active.isPending,
            isError: active.isError,
            error: active.error,
            refetch: active.refetch,
          }}
          empty="No cars are overdue."
        >
          {(rows) => (
            <ul className={ul}>
              {rows.map((b) => (
                <BookingLine
                  key={b.id}
                  booking={b}
                  now={now}
                  meta={<Badge tone="red">{formatDuration(now - new Date(b.return_due_at).getTime())} late</Badge>}
                  detail={`Due back ${formatRelativeDay(b.return_due_at, now)}`}
                />
              ))}
            </ul>
          )}
        </QueryState>
      </CardBody>
    </Card>
  );
}

// ------------------------------------------------------------------ DSH-04

const FLEET_ORDER: FleetState[] = ['available', 'on_trip', 'maintenance', 'inactive'];
const FLEET_TILE: Record<FleetState, string> = {
  available: 'bg-emerald-50 ring-emerald-300',
  on_trip: 'bg-blue-50 ring-blue-300',
  maintenance: 'bg-amber-50 ring-amber-300',
  inactive: 'bg-subtle ring-line',
};

const carLink = (car: Car) => `/admin/fleet/${car.id}`;

function FleetRow({ entry, now }: { entry: FleetEntry; now: number }) {
  const { car, booking, maintenance } = entry;
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 border-b border-line-card py-2 last:border-0">
      <Link to={carLink(car)} className="inline-flex min-h-11 items-center font-semibold">
        {car.display_name}
      </Link>
      {car.registration_number && <span className="font-mono text-sm text-muted">{car.registration_number}</span>}
      {booking && (
        <span className="text-[15px] text-ink-2">
          Back by {formatRelativeDay(booking.return_due_at, now)} ·{' '}
          <Link to={`/admin/bookings/${encodeURIComponent(booking.booking_code)}`} className="font-mono">
            {booking.booking_code}
          </Link>
        </span>
      )}
      {maintenance && (
        <span className="text-[15px] text-ink-2">
          {MAINTENANCE_REASON_LABELS[maintenance.reason]} until {formatRelativeDay(maintenance.ends_at, now)}
        </span>
      )}
    </li>
  );
}

export function FleetNowCard({ now }: { now: number }) {
  const cars = useCars();
  const active = useActiveBookings();
  const windows = useOpenMaintenance(true);
  const pending = cars.isPending || active.isPending || windows.isPending;
  const failed = cars.isError ? cars : active.isError ? active : windows.isError ? windows : null;
  const entries = cars.data && active.data && windows.data ? classifyFleet(cars.data, active.data, windows.data, now) : [];
  const groups = FLEET_ORDER.map((state) => ({ state, list: entries.filter((e) => e.state === state) }));

  return (
    <Card>
      <CardHeader title="Fleet now" actions={<CardLink to="/admin/fleet">Fleet</CardLink>} />
      <CardBody>
        <QueryState
          query={{
            data: pending || failed ? undefined : entries,
            isPending: pending && !failed,
            isError: Boolean(failed),
            error: failed?.error ?? null,
            refetch: failed?.refetch ?? cars.refetch,
          }}
          empty="No cars yet."
        >
          {() => (
            <>
              <ul className="m-0 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-4">
                {groups.map(({ state, list }) => (
                  <li key={state} className={cn('rounded-xl px-3 py-2 ring-1 ring-inset', FLEET_TILE[state])}>
                    <span className="block text-[26px] leading-tight font-extrabold">{list.length}</span>
                    <span className="block text-sm font-semibold text-ink-2">{FLEET_STATE_LABELS[state]}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-4 flex flex-col gap-4">
                {groups
                  .filter((g) => g.list.length > 0)
                  .map(({ state, list }) => (
                    <div key={state}>
                      <SubHeading>{FLEET_STATE_LABELS[state]}</SubHeading>
                      {state === 'available' || state === 'inactive' ? (
                        <ul className="m-0 flex list-none flex-wrap gap-x-4 p-0">
                          {list.map(({ car }) => (
                            <li key={car.id}>
                              <Link to={carLink(car)} className="inline-flex min-h-11 items-center">
                                {car.display_name}
                              </Link>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <ul className={ul}>
                          {list.map((e) => (
                            <FleetRow key={e.car.id} entry={e} now={now} />
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
              </div>
            </>
          )}
        </QueryState>
      </CardBody>
    </Card>
  );
}

// ------------------------------------------------------------------ DSH-05

interface KycGroup {
  customerId: string | null;
  name: string;
  docs: PendingKycDoc[];
}

function groupByCustomer(docs: PendingKycDoc[]): KycGroup[] {
  const groups = new Map<string, KycGroup>();
  for (const d of docs) {
    const key = d.customer_id ?? d.id;
    const g = groups.get(key) ?? { customerId: d.customer_id, name: d.customer?.full_name ?? 'Customer', docs: [] };
    g.docs.push(d);
    groups.set(key, g);
  }
  return [...groups.values()];
}

const rowLink =
  '-mx-2 block min-h-11 rounded-xl px-2 py-1.5 text-ink no-underline hover:bg-subtle hover:text-ink';

export function DocumentAlertsCard({ now, todayIso }: { now: number; todayIso: string }) {
  const papers = useCarPaperAlerts(todayIso, true);
  const kyc = usePendingKyc(true);
  const types = useDocumentTypes();
  const cars = useCars();
  const label = (key: string) => types.data?.find((t) => t.key === key)?.label ?? key;
  const carOf = (id: string | null) => cars.data?.find((c) => c.id === id);

  return (
    <Card>
      <CardHeader
        title="Document alerts"
        description="Vehicle papers expired or expiring within 30 days, and customer documents to verify."
        actions={<CardLink to="/admin/documents">Document centre</CardLink>}
      />
      <CardBody className="flex flex-col gap-5">
        <div>
          <SubHeading count={papers.data?.length} tone="red">
            Vehicle papers
          </SubHeading>
          <QueryState query={papers} empty="No vehicle papers expire in the next 30 days.">
            {(rows) => (
              <ul className={ul}>
                {rows.map((d) => {
                  const car = carOf(d.car_id);
                  const state = expiryState(d.expiry_date, todayIso);
                  return (
                    <li key={d.id} className="border-b border-line-card py-1.5 last:border-0">
                      <Link to={d.car_id ? `/admin/fleet/${d.car_id}` : '/admin/documents'} className={rowLink}>
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="font-semibold">{car?.display_name ?? 'Car'}</span>
                          {car?.registration_number && <span className="font-mono text-sm text-muted">{car.registration_number}</span>}
                          <ExpiryPill state={state} />
                        </span>
                        <span className="block text-[15px] text-ink-2">
                          {label(d.doc_type)} · {state === 'expired' ? 'expired' : 'expires'} {d.expiry_date ? formatIsoDate(d.expiry_date) : ''}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </QueryState>
        </div>
        <div>
          <SubHeading count={kyc.data ? groupByCustomer(kyc.data).length : undefined} tone="amber">
            Customer documents to verify
          </SubHeading>
          <QueryState query={kyc} empty="No customer documents are waiting.">
            {(rows) => (
              <ul className={ul}>
                {groupByCustomer(rows).map((g) => (
                  <li key={g.customerId ?? g.docs[0].id} className="border-b border-line-card py-1.5 last:border-0">
                    <Link to={g.customerId ? `/admin/customers/${g.customerId}` : '/admin/documents'} className={rowLink}>
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-semibold">{g.name}</span>
                        {g.docs.some((d) => d.uploaded_via === 'customer_link') && <Badge tone="blue">Sent by customer</Badge>}
                      </span>
                      <span className="block text-[15px] text-ink-2">{g.docs.map((d) => label(d.doc_type)).join(', ')}</span>
                      <span className="block text-sm text-muted">
                        Waiting {formatDuration(now - new Date(g.docs[0].created_at).getTime())}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </QueryState>
        </div>
      </CardBody>
    </Card>
  );
}

// ------------------------------------------------------------------ DSH-06 (P1)

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-xl bg-subtle px-4 py-3">
      <dt className="text-sm font-semibold text-ink-2">{label}</dt>
      <dd className="m-0 text-[28px] leading-tight font-extrabold">{value}</dd>
      {hint && <dd className="m-0 text-sm text-muted">{hint}</dd>}
    </div>
  );
}

export function ThisMonthCard({ todayIso }: { todayIso: string }) {
  const stats = useMonthStats(todayIso, true);
  const { startIso } = monthBounds(todayIso);
  return (
    <Card>
      <CardHeader
        title="This month"
        description={`${formatIsoDate(startIso)} to today`}
        actions={<CardLink to="/admin/reports">Reports</CardLink>}
      />
      <CardBody>
        <QueryState query={stats} isEmpty={() => false} empty="">
          {(s) => (
            <dl className="m-0 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Stat label="Bookings completed" value={s.completed} hint="Returned or closed" />
              <Stat label="Revenue recorded" value={formatRupees(s.revenuePaise)} hint="Rent and extras, less refunds" />
              <Stat
                label="Utilisation"
                value={s.utilisation === null ? '—' : `${Math.round(s.utilisation * 100)}%`}
                hint={`${Math.round(s.hoursRented)} of ${Math.round(s.hoursAvailable)} hours rented`}
              />
            </dl>
          )}
        </QueryState>
      </CardBody>
    </Card>
  );
}
