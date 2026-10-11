// /admin/bookings: search, filters and the bookings table (BKA-01, BKA-02).
// Staff see bookings from yesterday to tomorrow only; row-level security enforces it.
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Plus } from 'lucide-react';
import { displayStatus } from '@shared/booking.ts';
import { BookingCode, FlagPills, PaymentPill, StatusPill } from '@/components/ui/Badges';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Field';
import { DataTable, EmptyState, PageHeader, type Column } from '@/components/ui/Layout';
import { PageSpinner, Spinner } from '@/components/ui/Spinner';
import { errorMessage } from '@/lib/errors';
import { formatRelativeDay, formatRupees, istDateIso, pluralize } from '@/lib/format';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { useNow } from '@/lib/useNow';
import type { BookingWithRefs } from '@/types/db';
import { isOwnerOrManager, useAuth } from '../../auth/AuthProvider';
import { useCars } from '../../hooks/queries';
import { BookingFilters } from './list/BookingFilters';
import { carName, HIDDEN_CUSTOMER, packageLabel } from './list/bookingFormat';
import { CallLink } from './list/CallLink';
import { PAGE_SIZE, readFilters, useBookingsList, writeFilters, type ListFilters } from './list/useBookingsList';

const SEARCH_PAUSE_MS = 350;

export default function BookingsListPage() {
  useDocumentMeta({ title: 'Bookings · KSR admin', noindex: true });
  const { role } = useAuth();
  const canCreate = isOwnerOrManager(role);
  const navigate = useNavigate();
  const now = useNow();
  const todayIso = istDateIso(now);

  const [params, setParams] = useSearchParams();
  const filters = readFilters(params);
  const cars = useCars();

  // The search box applies after a short pause in typing, or straight away on Enter.
  const [searchText, setSearchText] = useState(filters.q);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const t = timer;
    return () => window.clearTimeout(t.current);
  }, []);

  // "Show more" grows the page; any filter change starts again from the first page.
  const filterKey = params.toString();
  const [more, setMore] = useState({ key: filterKey, limit: PAGE_SIZE });
  const limit = more.key === filterKey ? more.limit : PAGE_SIZE;

  const list = useBookingsList(filters, limit, todayIso, cars.data);

  // Every filter change also applies the text in the search box, so a pending search is never lost.
  function update(patch: Partial<ListFilters>) {
    window.clearTimeout(timer.current);
    setParams((prev) => writeFilters({ ...readFilters(prev), q: searchText, ...patch }), { replace: true });
  }

  function onSearchText(value: string) {
    setSearchText(value);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => update({ q: value }), SEARCH_PAUSE_MS);
  }

  const onSearchSubmit = () => update({});

  function clearAll() {
    window.clearTimeout(timer.current);
    setSearchText('');
    setParams(new URLSearchParams(), { replace: true });
  }

  const open = (b: BookingWithRefs) => navigate(`/admin/bookings/${encodeURIComponent(b.booking_code)}`);

  const codeLink = (b: BookingWithRefs) => (
    <Link
      to={`/admin/bookings/${encodeURIComponent(b.booking_code)}`}
      onClick={(e) => e.stopPropagation()}
      className="inline-flex min-h-11 items-center text-ink no-underline hover:underline"
    >
      <BookingCode code={b.booking_code} status={displayStatus(b, now)} />
    </Link>
  );

  const columns: Column<BookingWithRefs>[] = [
    { key: 'code', header: 'Code', hideOnMobile: true, className: 'whitespace-nowrap', cell: codeLink },
    { key: 'status', header: 'Status', hideOnMobile: true, cell: (b) => <StatusPill status={displayStatus(b, now)} /> },
    {
      key: 'pickup',
      header: 'Pickup',
      className: 'whitespace-nowrap',
      cell: (b) => formatRelativeDay(b.pickup_at, now),
    },
    {
      key: 'return',
      header: 'Return by',
      hideOnMobile: true,
      className: 'whitespace-nowrap',
      cell: (b) => formatRelativeDay(b.return_due_at, now),
    },
    {
      key: 'car',
      header: 'Car',
      cell: (b) => (
        <span className="inline-flex flex-col">
          <span>{carName(b)}</span>
          {b.car?.registration_number && <span className="font-mono text-sm text-muted">{b.car.registration_number}</span>}
        </span>
      ),
    },
    {
      key: 'customer',
      header: 'Customer',
      cell: (b) => (b.customer ? b.customer.full_name : <span className="text-muted">{HIDDEN_CUSTOMER}</span>),
    },
    {
      key: 'mobile',
      header: 'Mobile',
      cell: (b) => (b.customer?.phone ? <CallLink phone={b.customer.phone} name={b.customer.full_name} /> : <span className="text-muted">—</span>),
    },
    { key: 'package', header: 'Package', hideOnMobile: true, className: 'whitespace-nowrap', cell: packageLabel },
    { key: 'amount', header: 'Amount', className: 'whitespace-nowrap text-right', cell: (b) => formatRupees(b.total_paise) },
    { key: 'payment', header: 'Payment', cell: (b) => <PaymentPill status={b.payment_status} /> },
    {
      key: 'flags',
      header: 'Flags',
      cell: (b) => (b.flags.length ? <FlagPills flags={b.flags} /> : <span className="text-muted">—</span>),
    },
  ];

  const rows = list.data?.rows ?? [];
  const count = list.data?.count ?? 0;
  const isDefault = !params.toString();

  return (
    <>
      <PageHeader
        title="Bookings"
        description={role === 'staff' ? 'You can see bookings from yesterday to tomorrow, and cars that are out now.' : undefined}
        actions={
          canCreate && (
            <ButtonLink to="/admin/bookings/new" icon={<Plus size={18} aria-hidden="true" />}>
              New booking
            </ButtonLink>
          )
        }
      />

      <BookingFilters
        filters={filters}
        cars={cars.data ?? []}
        searchText={searchText}
        onSearchText={onSearchText}
        onSearchSubmit={onSearchSubmit}
        onChange={update}
        onClear={clearAll}
      />

      <div className="mb-3 flex min-h-6 items-center gap-2 text-[15px] text-muted">
        <p className="m-0" aria-live="polite">
          {list.isPending
            ? 'Loading bookings…'
            : list.isError
              ? ''
              : count === 0
                ? 'No bookings match.'
                : `Showing ${rows.length} of ${pluralize(count, 'booking')}.`}
        </p>
        {list.isFetching && !list.isPending && <Spinner size={16} label="Updating" />}
      </div>

      {list.isError ? (
        <Alert title="Couldn't load bookings">
          <p className="m-0">{errorMessage(list.error)}</p>
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => void list.refetch()}>
            Try again
          </Button>
        </Alert>
      ) : list.isPending ? (
        <PageSpinner label="Loading bookings" />
      ) : (
        <>
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(b) => b.id}
            onRowClick={open}
            caption="Bookings"
            mobileTitle={(b) => (
              <div className="flex flex-wrap items-center justify-between gap-2">
                {codeLink(b)}
                <StatusPill status={displayStatus(b, now)} />
              </div>
            )}
            empty={
              isDefault ? (
                <EmptyState
                  title="No upcoming bookings"
                  action={
                    canCreate && (
                      <ButtonLink to="/admin/bookings/new" variant="secondary" size="sm">
                        New booking
                      </ButtonLink>
                    )
                  }
                >
                  New requests from the website appear here.
                </EmptyState>
              ) : (
                <EmptyState
                  title="No bookings match"
                  action={
                    <Button variant="secondary" size="sm" onClick={clearAll}>
                      Clear search and filters
                    </Button>
                  }
                >
                  Check the spelling, or try All instead of Upcoming.
                </EmptyState>
              )
            }
          />
          {rows.length < count && (
            <div className="mt-4 flex justify-center">
              <Button
                variant="secondary"
                loading={list.isFetching}
                loadingText="Loading…"
                onClick={() => setMore({ key: filterKey, limit: limit + PAGE_SIZE })}
              >
                Show more
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
