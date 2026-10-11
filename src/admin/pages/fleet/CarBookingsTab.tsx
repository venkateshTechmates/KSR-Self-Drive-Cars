// Bookings tab: booking history for one car, latest first.
import { Link } from 'react-router';
import { PACKAGE_LABELS } from '@shared/constants.ts';
import { displayStatus } from '@shared/booking.ts';
import { BookingCode, StatusPill } from '@/components/ui/Badges';
import { Alert } from '@/components/ui/Field';
import { Card, CardBody, CardHeader, DataTable, EmptyState, type Column } from '@/components/ui/Layout';
import { Spinner } from '@/components/ui/Spinner';
import { errorMessage } from '@/lib/errors';
import { formatRupees, formatWhen } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import type { Car } from '@/types/db';
import { useCarBookings, type CarBookingRow } from './fleetData';

export function CarBookingsTab({ car }: { car: Car }) {
  const now = useNow();
  const bookings = useCarBookings(car.id);
  const rows = bookings.data ?? [];

  const columns: Column<CarBookingRow>[] = [
    {
      key: 'code',
      header: 'Booking',
      hideOnMobile: true,
      cell: (b) => (
        <Link to={`/admin/bookings/${b.booking_code}`}>
          <BookingCode code={b.booking_code} status={displayStatus(b, now)} />
        </Link>
      ),
    },
    { key: 'status', header: 'Status', cell: (b) => <StatusPill status={displayStatus(b, now)} /> },
    { key: 'pickup', header: 'Pickup', cell: (b) => formatWhen(b.pickup_at), className: 'whitespace-nowrap' },
    { key: 'return', header: 'Return by', cell: (b) => formatWhen(b.return_due_at), className: 'whitespace-nowrap' },
    { key: 'package', header: 'Package', cell: (b) => PACKAGE_LABELS[b.package] },
    { key: 'customer', header: 'Customer', cell: (b) => b.customer?.full_name ?? '—' },
    { key: 'total', header: 'Total', cell: (b) => formatRupees(b.total_paise), className: 'whitespace-nowrap' },
  ];

  return (
    <Card>
      <CardHeader title="Bookings" description={rows.length >= 200 ? 'Latest 200 bookings.' : undefined} />
      <CardBody>
        {bookings.isLoading ? (
          <div className="flex justify-center p-6">
            <Spinner label="Loading bookings" />
          </div>
        ) : bookings.error ? (
          <Alert title="Couldn't load bookings">{errorMessage(bookings.error)}</Alert>
        ) : (
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(b) => b.id}
            caption={`Bookings for ${car.display_name}, latest first`}
            mobileTitle={(b) => (
              <Link to={`/admin/bookings/${b.booking_code}`}>
                <BookingCode code={b.booking_code} status={displayStatus(b, now)} />
              </Link>
            )}
            empty={<EmptyState title="No bookings for this car yet" />}
          />
        )}
      </CardBody>
    </Card>
  );
}
