// /admin/fleet: cars list with photo, status, prices, next booking and paper warnings (FLT-01).
// Display order is sort_order; move buttons reorder it (keyboard and touch friendly).
import { useState } from 'react';
import { Link } from 'react-router';
import { ArrowDown, ArrowUp, Plus, Wrench } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { formatIsoDate } from '@shared/time.ts';
import { CarImage } from '@/components/brand/Brand';
import { Badge } from '@/components/ui/Badges';
import { ButtonLink, IconButton } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Field';
import { DataTable, EmptyState, PageHeader, type Column } from '@/components/ui/Layout';
import { PageSpinner } from '@/components/ui/Spinner';
import { api } from '@/integrations/api/client';
import { errorMessage, unwrap } from '@/lib/errors';
import { formatRelativeDay, formatRupees, istDateIso } from '@/lib/format';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { useNow } from '@/lib/useNow';
import type { Car, CarPhoto } from '@/types/db';
import { qk, useCars, useDocumentTypes } from '../../hooks/queries';
import {
  blockingPaperTypes,
  coverOf,
  paperWarnings,
  useAllCarPhotos,
  useFleetPapers,
  useMaintenanceNow,
  useNextBookings,
  type PaperWarning,
} from './fleetData';

export default function FleetListPage() {
  useDocumentMeta({ title: 'Fleet · KSR admin', noindex: true });
  const queryClient = useQueryClient();
  const now = useNow();
  const today = istDateIso(now);
  const cars = useCars();
  const photos = useAllCarPhotos();
  const next = useNextBookings();
  const maintenance = useMaintenanceNow();
  const docTypes = useDocumentTypes();
  const paperTypes = blockingPaperTypes(docTypes.data);
  const papers = useFleetPapers(paperTypes.map((t) => t.key));
  const [saving, setSaving] = useState(false);
  const [announce, setAnnounce] = useState('');

  const list = cars.data ?? [];
  const activeCount = list.filter((c) => c.status === 'active').length;

  async function move(car: Car, dir: -1 | 1) {
    const index = list.findIndex((c) => c.id === car.id);
    const target = index + dir;
    if (saving || index < 0 || target < 0 || target >= list.length) return;
    const reordered = [...list];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    const renumbered = reordered.map((c, i) => ({ ...c, sort_order: (i + 1) * 10 }));
    const changed = renumbered.filter((c) => list.find((o) => o.id === c.id)?.sort_order !== c.sort_order);
    const previous = queryClient.getQueryData<Car[]>(qk.cars);
    queryClient.setQueryData(qk.cars, renumbered);
    setSaving(true);
    try {
      await Promise.all(
        changed.map((c) =>
          api
            .from('cars')
            .update({ sort_order: c.sort_order })
            .eq('id', c.id)
            .then((r) => unwrap(r)),
        ),
      );
      setAnnounce(`${car.display_name} moved to position ${target + 1} of ${list.length}.`);
    } catch (err) {
      queryClient.setQueryData(qk.cars, previous);
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
      void queryClient.invalidateQueries({ queryKey: qk.cars });
      // Keep keyboard focus on the moved car's button (the visible layout's copy).
      requestAnimationFrame(() => {
        const pick = (d: string) =>
          Array.from(document.querySelectorAll<HTMLButtonElement>(`[data-move="${d}"][data-car="${car.id}"]`)).find(
            (el) => el.offsetParent !== null && !el.disabled,
          );
        (pick(dir < 0 ? 'up' : 'down') ?? pick(dir < 0 ? 'down' : 'up'))?.focus();
      });
    }
  }

  const thumb = (car: Car) => {
    const cover = coverOf(car, photos.data ?? []);
    return (
      <span className="flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-tile">
        <CarImage photo={cover ? toThumb(cover) : null} category={car.category} sizes="96px" />
      </span>
    );
  };

  const statusCell = (car: Car) => (
    <span className="inline-flex flex-wrap justify-end gap-1 md:justify-start">
      <Badge tone={car.status === 'active' ? 'green' : 'grey'}>{car.status === 'active' ? 'Active' : 'Inactive'}</Badge>
      {maintenance.data?.has(car.id) && (
        <Badge tone="amber">
          <Wrench size={12} aria-hidden="true" /> In maintenance now
        </Badge>
      )}
    </span>
  );

  const nextCell = (car: Car) => {
    const b = next.data?.get(car.id);
    if (!b) return <span className="text-muted">None</span>;
    return (
      <span className="inline-flex flex-col items-end md:items-start">
        <Link to={`/admin/bookings/${b.booking_code}`} className="font-mono text-[14px] font-semibold">
          {b.booking_code}
        </Link>
        <span className="text-sm text-muted">
          {formatRelativeDay(b.pickup_at, now)}
          {b.status === 'requested' && ' · Requested'}
        </span>
      </span>
    );
  };

  const papersCell = (car: Car) => {
    if (!papers.data) return <span className="text-muted">…</span>;
    const warnings = paperWarnings(car.id, papers.data, paperTypes, today);
    if (warnings.length === 0) return <span className="font-semibold text-emerald-800">Papers OK</span>;
    return (
      <span className="inline-flex flex-wrap justify-end gap-1 md:justify-start">
        {warnings.map((w) => (
          <PaperBadge key={w.key} warning={w} />
        ))}
      </span>
    );
  };

  const orderCell = (car: Car) => {
    const i = list.findIndex((c) => c.id === car.id);
    return (
      <span className="inline-flex gap-1">
        <IconButton
          label={`Move ${car.display_name} up`}
          data-move="up"
          data-car={car.id}
          disabled={i <= 0}
          onClick={() => void move(car, -1)}
          className="border border-line-input"
        >
          <ArrowUp size={18} aria-hidden="true" />
        </IconButton>
        <IconButton
          label={`Move ${car.display_name} down`}
          data-move="down"
          data-car={car.id}
          disabled={i >= list.length - 1}
          onClick={() => void move(car, 1)}
          className="border border-line-input"
        >
          <ArrowDown size={18} aria-hidden="true" />
        </IconButton>
      </span>
    );
  };

  const columns: Column<Car>[] = [
    { key: 'photo', header: <span className="sr-only">Photo</span>, cell: thumb, hideOnMobile: true, className: 'w-28' },
    {
      key: 'car',
      header: 'Car',
      hideOnMobile: true,
      cell: (car) => (
        <span className="flex flex-col">
          <Link to={`/admin/fleet/${car.id}`} className="font-semibold">
            {car.display_name}
          </Link>
          <span className="font-mono text-sm text-muted">{car.registration_number ?? 'No registration'}</span>
        </span>
      ),
    },
    { key: 'status', header: 'Status', cell: statusCell },
    { key: 'p12', header: '12 hr', cell: (car) => formatRupees(car.price_12h_paise), className: 'whitespace-nowrap' },
    { key: 'p24', header: '24 hr', cell: (car) => formatRupees(car.price_24h_paise), className: 'whitespace-nowrap' },
    { key: 'next', header: 'Next booking', cell: nextCell },
    { key: 'papers', header: 'Papers', cell: papersCell },
    { key: 'order', header: 'Order', cell: orderCell },
  ];

  return (
    <>
      <PageHeader
        title="Fleet"
        description={cars.data ? `${list.length} cars · ${activeCount} active. Cars show on the website in this order.` : undefined}
        actions={
          <ButtonLink to="/admin/fleet/new" icon={<Plus size={18} aria-hidden="true" />}>
            Add car
          </ButtonLink>
        }
      />
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>
      {cars.isLoading ? (
        <PageSpinner label="Loading cars" />
      ) : cars.error ? (
        <Alert title="Couldn't load the fleet">{errorMessage(cars.error)}</Alert>
      ) : (
        <DataTable
          rows={list}
          columns={columns}
          rowKey={(car) => car.id}
          caption="Cars in display order"
          mobileTitle={(car) => (
            <span className="flex items-center gap-3">
              {thumb(car)}
              <span className="flex min-w-0 flex-col">
                <Link to={`/admin/fleet/${car.id}`} className="text-[17px] font-semibold">
                  {car.display_name}
                </Link>
                <span className="font-mono text-sm text-muted">{car.registration_number ?? 'No registration'}</span>
              </span>
            </span>
          )}
          empty={
            <EmptyState
              title="No cars yet"
              action={
                <ButtonLink to="/admin/fleet/new" icon={<Plus size={18} aria-hidden="true" />}>
                  Add car
                </ButtonLink>
              }
            >
              Add your first car, then its photos, prices and papers.
            </EmptyState>
          }
        />
      )}
    </>
  );
}

const toThumb = (p: CarPhoto) => ({ id: p.id, path: p.storage_path, alt: '', width: p.width, height: p.height });

function PaperBadge({ warning }: { warning: PaperWarning }) {
  if (warning.state === 'missing') return <Badge tone="amber">{warning.label} missing</Badge>;
  if (warning.state === 'expired') {
    return <Badge tone="red">{warning.label} expired{warning.expiry ? ` ${formatIsoDate(warning.expiry)}` : ''}</Badge>;
  }
  return <Badge tone="amber">{warning.label} expires {warning.expiry ? formatIsoDate(warning.expiry) : 'soon'}</Badge>;
}
