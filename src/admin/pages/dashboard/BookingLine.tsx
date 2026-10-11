// One booking in a dashboard list: opens the booking; the call button sits beside it (DSH-02).
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { displayStatus } from '@shared/booking.ts';
import { Badge, BookingCode, StatusPill } from '@/components/ui/Badges';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Spinner';
import { errorMessage } from '@/lib/errors';
import type { BookingWithRefs } from '@/types/db';
import { carName, customerName } from '../bookings/list/bookingFormat';
import { CallLink } from '../bookings/list/CallLink';

export function BookingLine({
  booking,
  now,
  lead,
  meta,
  detail,
}: {
  booking: BookingWithRefs;
  now: number;
  /** Bold text before the code, e.g. the pickup time. */
  lead?: ReactNode;
  /** Shown after the status, e.g. flags or how late. */
  meta?: ReactNode;
  /** Small third line. */
  detail?: ReactNode;
}) {
  const status = displayStatus(booking, now);
  const reg = booking.car?.registration_number;
  return (
    <li className="flex items-center gap-2 border-b border-line-card py-1.5 last:border-0">
      <Link
        to={`/admin/bookings/${encodeURIComponent(booking.booking_code)}`}
        className="-mx-2 block min-h-11 min-w-0 flex-1 rounded-xl px-2 py-1.5 text-ink no-underline hover:bg-subtle hover:text-ink"
      >
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {lead && <span className="font-bold whitespace-nowrap">{lead}</span>}
          <BookingCode code={booking.booking_code} status={status} />
          <StatusPill status={status} />
          {meta}
        </span>
        <span className="mt-0.5 block text-[15px] text-ink-2">
          {carName(booking)}
          {reg && <span className="font-mono text-sm text-muted"> {reg}</span>}
          <span className="text-muted"> · </span>
          <span className={booking.customer ? undefined : 'text-muted'}>{customerName(booking)}</span>
        </span>
        {detail && <span className="mt-0.5 block text-sm text-muted">{detail}</span>}
      </Link>
      <CallLink phone={booking.customer?.phone} name={booking.customer?.full_name} showNumber="sm" />
    </li>
  );
}

/** Small heading with a count inside a dashboard card. */
export function SubHeading({ children, count, tone = 'grey' }: { children: ReactNode; count?: number; tone?: 'grey' | 'amber' | 'red' }) {
  return (
    <h3 className="m-0 mb-1 flex items-center gap-2 text-[15px] font-bold">
      {children}
      {count !== undefined && <Badge tone={count > 0 ? tone : 'grey'}>{count}</Badge>}
    </h3>
  );
}

/** The parts of a query result QueryState needs (a UseQueryResult fits). */
export interface QueryLike<T> {
  data: T | undefined;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
}

/** Spinner, error with retry, an empty line, or the content. */
export function QueryState<T>({
  query,
  empty,
  isEmpty,
  children,
}: {
  query: QueryLike<T>;
  empty: ReactNode;
  isEmpty?: (data: T) => boolean;
  children: (data: T) => ReactNode;
}) {
  if (query.isPending) {
    return (
      <p className="m-0 flex items-center gap-2 py-2 text-muted" role="status">
        <Spinner size={16} /> Loading…
      </p>
    );
  }
  if (query.isError || query.data === undefined) {
    return (
      <Alert className="my-1">
        <span>{errorMessage(query.error)} </span>
        <Button variant="ghost" size="sm" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </Alert>
    );
  }
  const data = query.data;
  const none = isEmpty ? isEmpty(data) : Array.isArray(data) && data.length === 0;
  if (none) return <p className="m-0 py-2 text-muted">{empty}</p>;
  return <>{children(data)}</>;
}
