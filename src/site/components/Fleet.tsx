// Fleet (FLE-01..04): active cars in admin order, 12/24 hr toggle, filters with counts.
import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { BODY_TYPE_LABELS, FUEL_LABELS, TRANSMISSION_LABELS, type CarCategory } from '@shared/constants.ts';
import { formatRupees } from '@shared/money.ts';
import { CarImage, PricePlate } from '@/components/brand/Brand';
import { buttonClass } from '@/components/ui/Button';
import { track } from '@/lib/analytics';
import { cn } from '@/lib/cn';
import type { PublicCar } from '@/types/db';
import { FuelIcon, GearIcon, SeatIcon } from './Icons';

export type FleetFilter = 'all' | CarCategory | 'cng';
export type Pkg = '12h' | '24h';

const FILTERS: Array<{ id: FleetFilter; label: string; short: string }> = [
  { id: 'all', label: 'All cars', short: 'All' },
  { id: 'hatch', label: 'Hatchbacks', short: 'Hatchbacks' },
  { id: 'suv', label: 'SUVs & crossovers', short: 'SUVs' },
  { id: 'mpv', label: '6–7 seaters', short: '6–7 seaters' },
  { id: 'cng', label: 'CNG', short: 'CNG' },
];

export const inFilter = (c: PublicCar, f: FleetFilter) => (f === 'all' ? true : f === 'cng' ? c.fuel === 'cng' : c.category === f);

interface FleetProps {
  cars: PublicCar[];
  filter: FleetFilter;
  onFilter: (f: FleetFilter) => void;
  pkg: Pkg;
  onPkg: (p: Pkg) => void;
  onBook: (car: PublicCar) => void;
}

export function Fleet({ cars, filter, onFilter, pkg, onPkg, onBook }: FleetProps) {
  const shown = cars.filter((c) => inFilter(c, filter));
  const ref = useRef<HTMLElement>(null);

  // fleet_viewed, once, when the fleet scrolls into view.
  useEffect(() => {
    const el = ref.current;
    if (!el || !('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          track('fleet_viewed');
          io.disconnect();
        }
      },
      { threshold: 0.2 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const seg = (id: Pkg, label: string, mobileLabel: string) => (
    <button
      type="button"
      aria-pressed={pkg === id}
      onClick={() => {
        onPkg(id);
        track('package_toggled', { package: id });
      }}
      className={cn(
        'min-h-11 rounded-full border-0 px-[18px] text-[15px] font-bold md:min-w-[104px]',
        pkg === id ? 'bg-black text-plate' : 'bg-transparent text-ink',
      )}
    >
      <span className="md:hidden">{mobileLabel}</span>
      <span className="hidden md:inline">{label}</span>
    </button>
  );

  return (
    <section ref={ref} id="fleet" aria-labelledby="fleet-heading" className="mx-auto max-w-[1240px] scroll-mt-4 px-5 py-8 sm:px-6 md:py-24">
      <div className="flex flex-wrap items-end justify-between gap-[18px] md:gap-6">
        <div className="flex flex-col gap-1.5 md:gap-2.5">
          <h2 id="fleet-heading" className="display m-0 text-[44px] md:text-[clamp(48px,5.4vw,76px)]">
            Our fleet
          </h2>
          <p className="m-0 max-w-[32em] text-ink-2 md:text-lg">
            <span className="hidden md:inline">Transparent pricing. </span>Every car comes with a 12 hr and a 24 hr package.
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 md:w-auto">
          <span id="pkg-label" className="hidden text-sm font-semibold text-ink-2 md:block">
            Show prices for
          </span>
          <div role="group" aria-labelledby="pkg-label" aria-label="Show prices for" className="grid grid-cols-2 gap-1 rounded-full border border-ink bg-white p-1 md:inline-flex">
            {seg('12h', '12 hrs', '12 hr prices')}
            {seg('24h', '24 hrs', '24 hr prices')}
          </div>
        </div>
      </div>

      <div role="group" aria-label="Filter cars by type" className="-mx-5 mt-[18px] flex gap-2 overflow-x-auto px-5 pt-0.5 pb-1 md:mx-0 md:mt-9 md:flex-wrap md:gap-2.5 md:overflow-visible md:px-0">
        {FILTERS.map((f) => {
          const on = f.id === filter;
          return (
            <button
              key={f.id}
              type="button"
              aria-pressed={on}
              onClick={() => {
                onFilter(f.id);
                track('fleet_filter_used', { filter: f.id });
              }}
              className={cn(
                'inline-flex min-h-11 flex-none items-center gap-1.5 rounded-full border px-4 text-sm font-semibold whitespace-nowrap md:gap-2 md:px-[18px] md:text-[15px]',
                on ? 'border-ink bg-ink text-white' : 'border-line-input bg-white text-ink md:bg-transparent',
              )}
            >
              <span className="md:hidden">{f.short}</span>
              <span className="hidden md:inline">{f.label}</span>
              <span className="font-medium opacity-80">{cars.filter((c) => inFilter(c, f.id)).length}</span>
            </button>
          );
        })}
      </div>
      <p aria-live="polite" className="m-0 mt-3 text-[13px] text-muted md:mt-4 md:text-sm">
        {filter === 'all' ? `Showing all ${cars.length} cars` : `Showing ${shown.length} of ${cars.length} cars`}
      </p>

      <div className="mt-3 flex flex-col gap-3 sm:grid sm:grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] sm:gap-6 md:mt-5">
        {shown.map((c, i) => (
          <CarCard key={c.id} car={c} pkg={pkg} onBook={() => onBook(c)} eager={i < 3} />
        ))}
      </div>
    </section>
  );
}

function Specs({ car, className }: { car: PublicCar; className?: string }) {
  return (
    <ul className={cn('m-0 flex list-none flex-wrap gap-x-[18px] gap-y-2 p-0 text-sm text-ink-2', className)}>
      <li className="flex items-center gap-1.5">
        <SeatIcon /> {car.seats} seats
      </li>
      <li className="flex items-center gap-1.5">
        <FuelIcon /> {FUEL_LABELS[car.fuel]}
      </li>
      <li className="flex items-center gap-1.5">
        <GearIcon /> {TRANSMISSION_LABELS[car.transmission]}
      </li>
    </ul>
  );
}

export function CarCard({ car, pkg, onBook, eager }: { car: PublicCar; pkg: Pkg; onBook: () => void; eager?: boolean }) {
  const main = pkg === '12h' ? car.price_12h_paise : car.price_24h_paise;
  const alt = pkg === '12h' ? car.price_24h_paise : car.price_12h_paise;
  const mainLabel = pkg === '12h' ? '12 hrs' : '24 hrs';
  const altLabel = pkg === '12h' ? '24 hrs' : '12 hrs';
  const photo = car.photos[0];
  const type = BODY_TYPE_LABELS[car.body_type];

  return (
    <article className="flex flex-col overflow-hidden rounded-2xl border border-line-card bg-white sm:rounded-[18px]">
      {/* Phone layout (design: compact horizontal card) */}
      <div className="flex flex-col gap-3 p-3 sm:hidden">
        <div className="flex items-center gap-3">
          <div className="flex h-[84px] w-[116px] flex-none items-center justify-center overflow-hidden rounded-[10px] bg-tile px-2 pt-2.5 pb-1.5">
            <CarImage photo={photo} category={car.category} sizes="116px" eager={eager} className={photo ? '' : undefined} />
          </div>
          <div className="flex min-w-0 flex-col gap-0.5">
            {car.badge && <span className="mb-[3px] self-start rounded-full bg-ink px-2 py-0.5 text-xs font-bold text-white">{car.badge}</span>}
            <h3 className="m-0 text-[17px] leading-tight font-bold">
              <Link to={`/cars/${car.slug}`} className="text-ink no-underline">
                {car.display_name}
              </Link>
            </h3>
            <p className="m-0 text-[13px] text-muted">{type}</p>
            <p className="m-0 text-[13px] text-ink-2">
              {car.seats} seats, {FUEL_LABELS[car.fuel]}, {TRANSMISSION_LABELS[car.transmission].toLowerCase()}
            </p>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2.5 border-t border-dashed border-line-dash pt-3">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <PricePlate size="sm">{formatRupees(main)}</PricePlate>
              <span className="text-[13px] text-muted">for {mainLabel}</span>
            </div>
            <span className="text-[13px] text-ink-2">
              {formatRupees(alt)} for {altLabel}
            </span>
          </div>
          <button type="button" onClick={onBook} aria-label={`Book ${car.display_name}`} className={buttonClass('primary', 'sm', 'px-5 text-[15px]')}>
            Book
          </button>
        </div>
      </div>

      {/* Tablet/desktop layout (design: vertical card) */}
      <div className="relative hidden h-[200px] items-center justify-center overflow-hidden bg-tile sm:flex">
        {car.badge && <span className="absolute top-3.5 left-3.5 z-10 rounded-full bg-white px-[11px] py-[5px] text-[13px] font-bold text-ink">{car.badge}</span>}
        <div className={cn('flex h-full w-full items-center justify-center', !photo && 'px-7 pt-[34px] pb-[18px]')}>
          <CarImage photo={photo} category={car.category} eager={eager} />
        </div>
      </div>
      <div className="hidden flex-1 flex-col gap-4 px-[22px] pt-5 pb-[22px] sm:flex">
        <div>
          <h3 className="m-0 text-[21px] leading-tight font-bold">
            <Link to={`/cars/${car.slug}`} className="text-ink no-underline hover:text-action">
              {car.display_name}
            </Link>
          </h3>
          <p className="m-0 mt-1 text-[15px] text-muted">{type}</p>
        </div>
        <Specs car={car} />
        <div className="mt-auto flex items-end justify-between gap-3 border-t border-dashed border-line-dash pt-4">
          <div>
            <PricePlate>{formatRupees(main)}</PricePlate>
            <span className="mt-1.5 block text-sm text-muted">for {mainLabel}</span>
          </div>
          <div className="text-right">
            <span className="block text-lg font-bold">{formatRupees(alt)}</span>
            <span className="block text-sm text-muted">for {altLabel}</span>
          </div>
        </div>
        <button type="button" onClick={onBook} aria-label={`Book ${car.display_name}`} className="flex min-h-12 items-center justify-center rounded-xl bg-action font-semibold text-white hover:bg-action-hover">
          Book this car
        </button>
      </div>
    </article>
  );
}
