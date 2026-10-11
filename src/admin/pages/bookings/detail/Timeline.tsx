// BKA-03: status changes, edits, payments and charges, newest first, with who and when.
import { ArrowRight, Banknote, Car, FileWarning, PencilLine, Receipt, ShieldAlert, StickyNote } from 'lucide-react';
import { BOOKING_STATUS_LABELS } from '@shared/constants.ts';
import { Card, CardHeader } from '@/components/ui/Layout';
import { Spinner } from '@/components/ui/Spinner';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import type { BookingEvent } from '@/types/db';
import { useStaffName } from '@/admin/hooks/queries';
import { useBookingEvents } from './api';

const KIND: Record<BookingEvent['kind'], { label: string; icon: typeof Car }> = {
  status: { label: 'Status', icon: ArrowRight },
  edit: { label: 'Edited', icon: PencilLine },
  handover: { label: 'Handover', icon: Car },
  payment: { label: 'Payment', icon: Banknote },
  charge: { label: 'Charge', icon: Receipt },
  note: { label: 'Note', icon: StickyNote },
  override: { label: 'Override', icon: ShieldAlert },
};

function title(e: BookingEvent): string {
  if (e.kind === 'status' && e.to_status) {
    return e.from_status
      ? `${BOOKING_STATUS_LABELS[e.from_status]} → ${BOOKING_STATUS_LABELS[e.to_status]}`
      : BOOKING_STATUS_LABELS[e.to_status];
  }
  return KIND[e.kind]?.label ?? e.kind;
}

export function Timeline({ bookingId }: { bookingId: string }) {
  const events = useBookingEvents(bookingId);
  const staffName = useStaffName();
  const rows = events.data ?? [];
  return (
    <Card>
      <CardHeader title="Timeline" description="Newest first." />
      {events.isLoading ? (
        <div className="flex justify-center p-5">
          <Spinner label="Loading timeline" />
        </div>
      ) : events.error ? (
        <p className="m-0 p-5 text-danger">{errorMessage(events.error)}</p>
      ) : rows.length === 0 ? (
        <p className="m-0 p-5 text-muted">Nothing recorded yet.</p>
      ) : (
        <ol className="m-0 list-none px-4 py-3 sm:px-5">
          {rows.map((e) => {
            const Icon = KIND[e.kind]?.icon ?? FileWarning;
            return (
              <li key={e.id} className="relative flex gap-3 pb-4 last:pb-0">
                <span
                  aria-hidden="true"
                  className={
                    e.kind === 'override'
                      ? 'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-danger-bg text-danger'
                      : 'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-tile text-ink-2'
                  }
                >
                  <Icon size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="m-0 font-semibold">
                    {title(e)}
                  </p>
                  {e.note && <p className="m-0 text-[15px] break-words whitespace-pre-line">{e.note}</p>}
                  <p className="m-0 text-sm text-muted">
                    {staffName(e.actor_id)}, <time dateTime={e.at}>{formatDateTime(e.at)}</time>
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
