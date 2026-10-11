// /admin/calendar (Owner, Manager): one row per car with time across days, in IST (CAL-01).
// Tap an empty slot to start a booking, tap a bar to open it (CAL-02). With a mouse or pen,
// drag a requested / confirmed booking to a free time or another car, then confirm (CAL-03).
// The keyboard and touch alternative is editing the time on the booking page.
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ChevronLeft, ChevronRight, Plus, Wrench } from 'lucide-react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { MAINTENANCE_REASON_LABELS, PACKAGE_LABELS } from '@shared/constants.ts';
import { addDaysIso, formatIsoDate, formatWhen, fromIst, isIsoDate, istStartOfDay, MS_HOUR, MS_MINUTE, weekdayOf } from '@shared/time.ts';
import { isStruck } from '@/components/ui/Badges';
import { Button, ButtonLink, IconButton } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { Alert, Input } from '@/components/ui/Field';
import { Chip, EmptyState, PageHeader, Toolbar } from '@/components/ui/Layout';
import { PageSpinner, Spinner } from '@/components/ui/Spinner';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/cn';
import { errorMessage, unwrap } from '@/lib/errors';
import { istDateIso } from '@/lib/format';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { useNow } from '@/lib/useNow';
import type { Car, Clash, MaintenanceWindow } from '@/types/db';
import { qk, useCars, useSetting } from '../../hooks/queries';
import { shortName } from '../fleet/fleetData';
import {
  BAR_CLASS,
  BAR_H,
  CAL_BOOKING_SELECT,
  CANCELLED_STATUSES,
  HATCH_STYLE,
  HOUR_PX,
  LANE_H,
  LEGEND,
  MOVABLE,
  ROW_PAD,
  SNAP_MS,
  VISIBLE_STATUSES,
  dayLabel,
  hourLabel,
  placeBookings,
  rowHeight,
  statusLabel,
  type CalBooking,
  type CalendarView,
} from './calendarLayout';

const HEADER_H = 52;
const HALF_HOUR = 30 * MS_MINUTE;
const NAME_COL = 'w-32 sm:w-44';

interface DragInfo {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  moved: boolean;
  carId: string;
}
interface Ghost {
  id: string;
  dxMs: number;
  carId: string;
}
interface PendingMove {
  booking: CalBooking;
  carId: string;
  pickup: number;
  ret: number;
}

/** Current time for event handlers (handlers passed to custom components look like render code to the lint). */
const clockNow = () => Date.now();

const laneAt = (x: number, y: number) => document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-car-lane]')?.dataset.carLane ?? null;

function clashText(c: Clash): string {
  return c.kind === 'booking'
    ? `That time isn't free: ${c.booking_code} holds the car from ${formatWhen(c.starts_at)} to ${formatWhen(c.ends_at)}.`
    : `That time isn't free: the car is in maintenance from ${formatWhen(c.starts_at)} to ${formatWhen(c.ends_at)}.`;
}

export default function CalendarPage() {
  useDocumentMeta({ title: 'Calendar · KSR admin', noindex: true });
  const now = useNow();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const cars = useCars();
  const business = useSetting('business');

  const today = istDateIso(now);
  const view: CalendarView = params.get('view') === 'day' ? 'day' : 'week';
  const dateParam = params.get('date') ?? '';
  const anchor = isIsoDate(dateParam) ? dateParam : today;
  const showCancelled = params.get('cancelled') === '1';
  const days = view === 'day' ? 1 : 7;
  const rangeStart = istStartOfDay(anchor).getTime();
  const rangeEnd = istStartOfDay(addDaysIso(anchor, days)).getTime();
  const startIso = new Date(rangeStart).toISOString();
  const endIso = new Date(rangeEnd).toISOString();
  const hourPx = HOUR_PX[view];
  const snapMs = SNAP_MS[view];
  const gridWidth = days * 24 * hourPx;
  const xOf = (t: number) => ((t - rangeStart) / MS_HOUR) * hourPx;

  const bookings = useQuery({
    queryKey: [...qk.bookings, 'calendar', startIso, endIso, showCancelled],
    queryFn: async () =>
      unwrap(
        await supabase
          .from('bookings')
          .select(CAL_BOOKING_SELECT)
          .in('status', showCancelled ? [...VISIBLE_STATUSES, ...CANCELLED_STATUSES] : VISIBLE_STATUSES)
          .lt('pickup_at', endIso)
          // Overlapping the range, plus Active bookings that are still out (overdue).
          .or(`return_due_at.gt."${startIso}",actual_return_at.gt."${startIso}",status.eq.active`)
          .order('pickup_at')
          .limit(2000),
      ) as unknown as CalBooking[],
    placeholderData: keepPreviousData,
  });

  const maintenance = useQuery({
    queryKey: [...qk.cars, 'calendar-maintenance', startIso, endIso],
    queryFn: async () =>
      unwrap(
        await supabase.from('maintenance_windows').select('*').lt('starts_at', endIso).gt('ends_at', startIso).order('starts_at'),
      ) as MaintenanceWindow[],
    placeholderData: keepPreviousData,
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragInfo | null>(null);
  const suppressClick = useRef<string | null>(null);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [checking, setChecking] = useState(false);

  // Bring "now" into view when today is on screen.
  const ready = cars.isSuccess;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const t = Date.now();
    if (t < rangeStart || t >= rangeEnd) {
      el.scrollLeft = 0;
      return;
    }
    el.scrollLeft = Math.max(0, ((t - rangeStart) / MS_HOUR) * hourPx - (view === 'day' ? 2 : 6) * hourPx);
  }, [ready, rangeStart, rangeEnd, hourPx, view]);

  function setQuery(changes: Record<string, string | null>) {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(changes)) {
        if (v === null) next.delete(k);
        else next.set(k, v);
      }
      return next;
    });
  }

  const carsById = new Map((cars.data ?? []).map((c) => [c.id, c]));
  const bookingsByCar = new Map<string, CalBooking[]>();
  for (const b of bookings.data ?? []) bookingsByCar.set(b.car_id, [...(bookingsByCar.get(b.car_id) ?? []), b]);
  const maintByCar = new Map<string, MaintenanceWindow[]>();
  for (const m of maintenance.data ?? []) maintByCar.set(m.car_id, [...(maintByCar.get(m.car_id) ?? []), m]);
  const rows = (cars.data ?? [])
    .filter((c) => c.status === 'active' || bookingsByCar.has(c.id) || maintByCar.has(c.id))
    .map((car) => ({ car, ...placeBookings(bookingsByCar.get(car.id) ?? [], now), windows: maintByCar.get(car.id) ?? [] }));
  const ghostBooking = ghost ? (bookings.data ?? []).find((b) => b.id === ghost.id) : undefined;

  // ------------------------------------------------------------------ new booking (CAL-02)

  function goNew(carId: string, pickup: number) {
    navigate(`/admin/bookings/new?car=${carId}&pickup=${encodeURIComponent(new Date(pickup).toISOString())}`);
  }

  function newBookingFor(car: Car) {
    const nowMs = clockNow();
    if (anchor <= today) {
      goNew(car.id, Math.ceil(nowMs / HALF_HOUR) * HALF_HOUR);
      return;
    }
    const open = business.data?.hours[weekdayOf(anchor)]?.open ?? '09:00';
    goNew(car.id, (fromIst(anchor, open) ?? istStartOfDay(anchor)).getTime());
  }

  function onLaneClick(e: MouseEvent<HTMLDivElement>, car: Car) {
    if (ghost || pending || checking) return;
    if (car.status !== 'active') {
      toast.error(`${car.display_name} is inactive. Set it to Active in Fleet to take bookings.`);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const t = rangeStart + Math.floor((((e.clientX - rect.left) / hourPx) * MS_HOUR) / snapMs) * snapMs;
    const nowMs = clockNow();
    if (t + snapMs <= nowMs) {
      toast.error('That time has passed. Tap a time from now on.');
      return;
    }
    goNew(car.id, Math.max(t, Math.ceil(nowMs / HALF_HOUR) * HALF_HOUR));
  }

  // ------------------------------------------------------------------ drag to reschedule (CAL-03)

  const snapDelta = (dx: number) => Math.round(((dx / hourPx) * MS_HOUR) / snapMs) * snapMs;

  function cancelDrag() {
    dragRef.current = null;
    setGhost(null);
  }

  function onBarPointerDown(e: PointerEvent<HTMLAnchorElement>, b: CalBooking) {
    suppressClick.current = null;
    // Touch scrolls the grid; touch users change the time on the booking page instead.
    if (e.pointerType === 'touch' || e.button !== 0 || pending || checking) return;
    dragRef.current = { id: b.id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, moved: false, carId: b.car_id };
  }

  function onBarPointerMove(e: PointerEvent<HTMLAnchorElement>, b: CalBooking) {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    const carId = laneAt(e.clientX, e.clientY) ?? d.carId;
    dragRef.current = { ...d, moved: true, carId };
    const dxMs = snapDelta(dx);
    setGhost((g) => (g && g.id === b.id && g.dxMs === dxMs && g.carId === carId ? g : { id: b.id, dxMs, carId }));
  }

  async function onBarPointerUp(e: PointerEvent<HTMLAnchorElement>, b: CalBooking) {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || d.pointerId !== e.pointerId || !d.moved) return;
    suppressClick.current = b.id;
    await proposeMove(b, snapDelta(e.clientX - d.startX), laneAt(e.clientX, e.clientY) ?? d.carId);
  }

  function onBarKeyDown(e: KeyboardEvent<HTMLAnchorElement>) {
    if (e.key === 'Escape' && dragRef.current) cancelDrag();
  }

  function onBarClick(e: MouseEvent<HTMLAnchorElement>, b: CalBooking) {
    e.stopPropagation();
    if (suppressClick.current === b.id) {
      e.preventDefault();
      suppressClick.current = null;
    }
  }

  async function proposeMove(b: CalBooking, dxMs: number, carId: string) {
    if (dxMs === 0 && carId === b.car_id) {
      setGhost(null);
      return;
    }
    setGhost({ id: b.id, dxMs, carId });
    const pickup = Date.parse(b.pickup_at) + dxMs;
    const ret = Date.parse(b.return_due_at) + dxMs;
    const target = carsById.get(carId);
    if (pickup < clockNow()) {
      toast.error('Choose a pickup time from now on.');
      setGhost(null);
      return;
    }
    if (!target || target.status !== 'active') {
      toast.error('That car is inactive. Choose an active car.');
      setGhost(null);
      return;
    }
    setChecking(true);
    try {
      const clashes = (unwrap(
        await supabase.rpc('car_clashes', {
          p_car: carId,
          p_start: new Date(pickup).toISOString(),
          p_end: new Date(ret).toISOString(),
          p_exclude: b.id,
        }),
      ) ?? []) as Clash[];
      if (clashes.length) {
        toast.error(clashText(clashes[0]));
        setGhost(null);
        return;
      }
      setPending({ booking: b, carId, pickup, ret });
    } catch (err) {
      toast.error(errorMessage(err));
      setGhost(null);
    } finally {
      setChecking(false);
    }
  }

  async function confirmMove() {
    if (!pending) return;
    unwrap(
      await supabase.rpc('update_booking', {
        p_booking: pending.booking.id,
        p_pickup_at: new Date(pending.pickup).toISOString(),
        p_car_id: pending.carId,
      }),
    );
    await queryClient.invalidateQueries({ queryKey: qk.bookings });
    toast.success(`${pending.booking.booking_code} moved`);
  }

  // ------------------------------------------------------------------ render

  const rangeLabel = view === 'day' ? `${dayLabel(anchor)} ${anchor.slice(0, 4)}` : `${formatIsoDate(anchor)} – ${formatIsoDate(addDaysIso(anchor, 6))}`;
  const gridBackground =
    view === 'day'
      ? `repeating-linear-gradient(to right, var(--color-line-card) 0 1px, transparent 1px ${hourPx}px)`
      : `repeating-linear-gradient(to right, var(--color-line) 0 1px, transparent 1px ${24 * hourPx}px), repeating-linear-gradient(to right, rgb(29 33 37 / 0.07) 0 1px, transparent 1px ${6 * hourPx}px)`;
  const nowX = now >= rangeStart && now < rangeEnd ? xOf(now) : null;
  const pastWidth = Math.min(gridWidth, Math.max(0, xOf(now)));
  const carName = (id: string) => carsById.get(id)?.display_name ?? 'this car';

  return (
    <>
      <PageHeader
        title="Calendar"
        description="Bookings and maintenance for every car, in India time."
        actions={
          <ButtonLink to="/admin/bookings/new" icon={<Plus size={18} aria-hidden="true" />}>
            New booking
          </ButtonLink>
        }
      />

      <Toolbar>
        <div className="flex items-center gap-1">
          <Button variant="secondary" size="sm" onClick={() => setQuery({ date: null })}>
            Today
          </Button>
          <IconButton
            label={view === 'day' ? 'Previous day' : 'Previous week'}
            onClick={() => setQuery({ date: addDaysIso(anchor, -days) })}
            className="border border-line-input"
          >
            <ChevronLeft size={20} aria-hidden="true" />
          </IconButton>
          <IconButton
            label={view === 'day' ? 'Next day' : 'Next week'}
            onClick={() => setQuery({ date: addDaysIso(anchor, days) })}
            className="border border-line-input"
          >
            <ChevronRight size={20} aria-hidden="true" />
          </IconButton>
        </div>
        <h2 className="m-0 self-center text-lg font-bold" aria-live="polite">
          {rangeLabel}
        </h2>
        <div className="w-44">
          <label htmlFor="calendar-date" className="sr-only">
            Go to date
          </label>
          <Input
            id="calendar-date"
            type="date"
            value={anchor}
            onChange={(e) => {
              if (isIsoDate(e.target.value)) setQuery({ date: e.target.value });
            }}
          />
        </div>
        <div className="flex gap-2" role="group" aria-label="View">
          <Chip pressed={view === 'day'} onClick={() => setQuery({ view: 'day' })}>
            Day
          </Chip>
          <Chip pressed={view === 'week'} onClick={() => setQuery({ view: null })}>
            Week
          </Chip>
        </div>
        <Chip pressed={showCancelled} onClick={() => setQuery({ cancelled: showCancelled ? null : '1' })}>
          Show cancelled
        </Chip>
        {(bookings.isFetching || maintenance.isFetching || checking) && (
          <span className="inline-flex items-center gap-2 text-sm text-muted" role="status">
            <Spinner size={14} /> {checking ? 'Checking the new time…' : 'Updating…'}
          </span>
        )}
      </Toolbar>

      {(bookings.error || maintenance.error) && (
        <Alert title="Couldn't load the calendar" className="mb-4">
          {errorMessage(bookings.error ?? maintenance.error)}
        </Alert>
      )}

      {cars.isLoading ? (
        <PageSpinner label="Loading calendar" />
      ) : cars.error ? (
        <Alert title="Couldn't load cars">{errorMessage(cars.error)}</Alert>
      ) : rows.length === 0 ? (
        <EmptyState title="No active cars" action={<ButtonLink to="/admin/fleet">Go to fleet</ButtonLink>}>
          Add a car or set one to Active to see it here.
        </EmptyState>
      ) : (
        <div
          ref={scrollRef}
          tabIndex={0}
          role="region"
          aria-label="Fleet calendar. Scroll sideways for more times."
          className="max-h-[calc(100dvh-15rem)] min-h-64 overflow-auto rounded-2xl border border-line-card bg-surface"
        >
          <div className="w-max min-w-full">
            {/* Time header */}
            <div className="sticky top-0 z-20 flex border-b border-line-card bg-subtle">
              <div
                className={cn('sticky left-0 z-30 flex shrink-0 items-end border-r border-line-card bg-subtle px-3 pb-1.5 text-[13px] font-semibold text-muted', NAME_COL)}
                style={{ height: HEADER_H }}
              >
                Car
              </div>
              <div className="relative shrink-0" style={{ width: gridWidth, height: HEADER_H }} aria-hidden="true">
                {view === 'day'
                  ? Array.from({ length: 24 }, (_, h) => (
                      <span
                        key={h}
                        className="absolute bottom-0 border-l border-line-card pb-1.5 pl-1 text-[12px] whitespace-nowrap text-muted"
                        style={{ left: h * hourPx, width: hourPx, height: HEADER_H / 2 }}
                      >
                        {hourLabel(h)}
                      </span>
                    ))
                  : Array.from({ length: 7 }, (_, d) => {
                      const iso = addDaysIso(anchor, d);
                      return (
                        <div key={iso} className="absolute inset-y-0 border-l border-line" style={{ left: d * 24 * hourPx, width: 24 * hourPx }}>
                          <span className={cn('absolute top-1 left-1.5 rounded px-1 text-[13px] font-semibold', iso === today ? 'bg-ink text-white' : 'text-ink')}>
                            {dayLabel(iso)}
                            {iso === today ? ' · Today' : ''}
                          </span>
                          {[6, 12, 18].map((h) => (
                            <span key={h} className="absolute bottom-1 pl-1 text-[11px] whitespace-nowrap text-muted" style={{ left: h * hourPx }}>
                              {hourLabel(h)}
                            </span>
                          ))}
                        </div>
                      );
                    })}
                {nowX !== null && <span className="absolute bottom-0 h-3 w-0.5 bg-red-600" style={{ left: nowX }} />}
              </div>
            </div>

            {/* One row per car */}
            <ul className="m-0 list-none p-0">
              {rows.map(({ car, placed, lanes, windows }) => {
                const height = rowHeight(lanes);
                const ghostHere = ghost && ghostBooking && ghost.carId === car.id ? ghost : null;
                return (
                  <li key={car.id} className="flex border-b border-line-card last:border-0">
                    <div className={cn('sticky left-0 z-10 flex shrink-0 items-center gap-1 border-r border-line-card bg-surface py-1 pr-1 pl-3', NAME_COL)} style={{ height }}>
                      <div className="min-w-0 flex-1">
                        <Link to={`/admin/fleet/${car.id}`} className="block truncate text-[14px] font-semibold" title={car.display_name}>
                          {car.display_name}
                        </Link>
                        {car.registration_number && <span className="block truncate font-mono text-[12px] text-muted">{car.registration_number}</span>}
                        {car.status !== 'active' && <span className="block text-[12px] font-semibold text-muted">Inactive</span>}
                      </div>
                      {car.status === 'active' && (
                        <IconButton label={`New booking for ${car.display_name}`} onClick={() => newBookingFor(car)} className="hidden sm:inline-flex">
                          <Plus size={18} aria-hidden="true" />
                        </IconButton>
                      )}
                    </div>

                    <div
                      data-car-lane={car.id}
                      className={cn('relative shrink-0', car.status === 'active' ? 'cursor-pointer' : 'cursor-not-allowed bg-subtle')}
                      style={{ width: gridWidth, height, backgroundImage: gridBackground }}
                      onClick={(e) => onLaneClick(e, car)}
                    >
                      {pastWidth > 0 && <div className="pointer-events-none absolute inset-y-0 left-0 bg-ink/[0.04]" style={{ width: pastWidth }} aria-hidden="true" />}

                      {windows.map((m) => {
                        const s = Math.max(rangeStart, Date.parse(m.starts_at));
                        const e = Math.min(rangeEnd, Date.parse(m.ends_at));
                        const left = xOf(s);
                        const width = Math.max(8, xOf(e) - left);
                        const reason = MAINTENANCE_REASON_LABELS[m.reason];
                        const text = `Maintenance (${reason}), ${formatWhen(m.starts_at)} to ${formatWhen(m.ends_at)}${m.notes ? `. ${m.notes}` : ''}`;
                        return (
                          <Link
                            key={m.id}
                            to={`/admin/fleet/${m.car_id}?tab=maintenance`}
                            draggable={false}
                            title={text}
                            onClick={(ev) => ev.stopPropagation()}
                            className="absolute inset-y-0 z-0 flex items-start overflow-hidden border-x-2 border-ink/40 px-1 pt-1 text-[12px] font-semibold text-ink no-underline hover:text-ink"
                            style={{ left, width, ...HATCH_STYLE }}
                          >
                            <span className="inline-flex max-w-full items-center gap-1 truncate rounded bg-white/90 px-1">
                              <Wrench size={12} aria-hidden="true" className="shrink-0" />
                              <span className="truncate">Maintenance{width > 110 ? ` · ${reason}` : ''}</span>
                            </span>
                            <span className="sr-only">
                              {' '}
                              ({reason}), {formatWhen(m.starts_at)} to {formatWhen(m.ends_at)}
                            </span>
                          </Link>
                        );
                      })}

                      {placed.map((p) => {
                        const b = p.booking;
                        const movable = MOVABLE.includes(b.status);
                        const left = Math.max(0, xOf(p.start));
                        const width = Math.max(24, Math.min(gridWidth, xOf(p.end)) - left);
                        const name = shortName(b.customer?.full_name);
                        const when = `pickup ${formatWhen(b.pickup_at)}, return by ${formatWhen(b.return_due_at)}`;
                        return (
                          <Link
                            key={b.id}
                            to={`/admin/bookings/${b.booking_code}`}
                            draggable={false}
                            title={`${b.booking_code} · ${statusLabel(p.status)}${name ? ` · ${name}` : ''}\n${when}`}
                            onClick={(e) => onBarClick(e, b)}
                            onPointerDown={movable ? (e) => onBarPointerDown(e, b) : undefined}
                            onPointerMove={movable ? (e) => onBarPointerMove(e, b) : undefined}
                            onPointerUp={movable ? (e) => void onBarPointerUp(e, b) : undefined}
                            onPointerCancel={movable ? cancelDrag : undefined}
                            onKeyDown={movable ? onBarKeyDown : undefined}
                            className={cn(
                              'absolute z-[1] flex flex-col justify-center overflow-hidden rounded-lg border border-l-4 px-1.5 text-[12px] leading-tight no-underline select-none focus-visible:z-[5]',
                              BAR_CLASS[p.status],
                              movable && 'cursor-grab active:cursor-grabbing',
                              ghost?.id === b.id && 'opacity-50',
                              p.start < rangeStart && 'rounded-l-none',
                              p.end > rangeEnd && 'rounded-r-none',
                            )}
                            style={{ left, width, top: ROW_PAD + p.lane * LANE_H, height: BAR_H }}
                          >
                            <span className={cn('truncate font-mono font-semibold', isStruck(p.status) && 'line-through')}>{b.booking_code}</span>
                            <span className="truncate">
                              {statusLabel(p.status)}
                              {name ? ` · ${name}` : ''}
                            </span>
                            <span className="sr-only">, {when}</span>
                          </Link>
                        );
                      })}

                      {ghostHere && ghostBooking && (
                        <div
                          className="pointer-events-none absolute z-[3] flex flex-col justify-center overflow-hidden rounded-lg border-2 border-dashed border-ink bg-white/85 px-1.5 text-[12px] leading-tight font-semibold text-ink"
                          style={{
                            left: xOf(Date.parse(ghostBooking.pickup_at) + ghostHere.dxMs),
                            width: Math.max(24, xOf(Date.parse(ghostBooking.return_due_at) + ghostHere.dxMs) - xOf(Date.parse(ghostBooking.pickup_at) + ghostHere.dxMs)),
                            top: ROW_PAD,
                            height: BAR_H,
                          }}
                          aria-hidden="true"
                        >
                          <span className="truncate">{ghostBooking.booking_code}</span>
                          <span className="truncate font-normal">{formatWhen(Date.parse(ghostBooking.pickup_at) + ghostHere.dxMs)}</span>
                        </div>
                      )}

                      {nowX !== null && <div className="pointer-events-none absolute inset-y-0 z-[2] w-0.5 bg-red-600" style={{ left: nowX }} aria-hidden="true" />}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-col gap-2">
        <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-2 p-0 text-[14px]" aria-label="Legend">
          {LEGEND.map((s) => (
            <li key={s} className="flex items-center gap-2">
              <span className={cn('inline-block h-5 w-8 rounded border border-l-4', BAR_CLASS[s])} aria-hidden="true" />
              {statusLabel(s)}
            </li>
          ))}
          {showCancelled && (
            <li className="flex items-center gap-2">
              <span className={cn('inline-block h-5 w-8 rounded border border-l-4', BAR_CLASS.cancelled)} aria-hidden="true" />
              Cancelled, rejected or no-show (code struck through)
            </li>
          )}
          <li className="flex items-center gap-2">
            <span className="inline-block h-5 w-8 rounded border border-ink/40" style={HATCH_STYLE} aria-hidden="true" />
            Maintenance (not bookable)
          </li>
          <li className="flex items-center gap-2">
            <span className="inline-block h-5 w-0.5 bg-red-600" aria-hidden="true" />
            Now
          </li>
        </ul>
        <p className="m-0 text-sm text-muted">
          Tap an empty time to start a booking for that car, or a booking to open it. With a mouse, drag a requested or confirmed booking to a free
          time or another car. On a phone, open the booking and change its time there.
        </p>
      </div>

      <ConfirmDialog
        open={Boolean(pending)}
        onClose={() => {
          setPending(null);
          setGhost(null);
        }}
        title={pending ? `Move ${pending.booking.booking_code}?` : 'Move booking?'}
        description="The new time is free. Let the customer know about the change."
        confirmLabel="Move booking"
        onConfirm={confirmMove}
      >
        {pending && (
          <>
            <dl className="m-0 grid gap-3 text-[15px]">
              <div>
                <dt className="text-sm text-muted">From</dt>
                <dd className="m-0 font-semibold">
                  {carName(pending.booking.car_id)} · {formatWhen(pending.booking.pickup_at)} to {formatWhen(pending.booking.return_due_at)}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted">To</dt>
                <dd className="m-0 font-semibold">
                  {carName(pending.carId)} · {formatWhen(pending.pickup)} to {formatWhen(pending.ret)}
                </dd>
              </div>
            </dl>
            {pending.carId !== pending.booking.car_id && pending.booking.package !== 'custom' && (
              <Alert tone="info">
                The price changes to the {carName(pending.carId)} {PACKAGE_LABELS[pending.booking.package]} price.
              </Alert>
            )}
          </>
        )}
      </ConfirmDialog>
    </>
  );
}
