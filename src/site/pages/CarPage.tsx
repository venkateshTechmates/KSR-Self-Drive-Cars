// Car detail page /cars/:slug (FLE-06): gallery, specs, prices and booking button.
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { BODY_TYPE_LABELS, FUEL_LABELS, TRANSMISSION_LABELS } from '@shared/constants.ts';
import { formatRupees } from '@shared/money.ts';
import { CarImage, PricePlate } from '@/components/brand/Brand';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/Layout';
import { PageSpinner } from '@/components/ui/Spinner';
import { carPhotoSrcSet, carPhotoUrl } from '@/lib/carPhotos';
import { cn } from '@/lib/cn';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { FuelIcon, GearIcon, SeatIcon } from '../components/Icons';
import { SitePage } from '../components/SiteChrome';
import { usePublicCars } from '../hooks/publicData';

export default function CarPage() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const cars = usePublicCars();
  const car = cars.data?.find((c) => c.slug === slug);
  const [active, setActive] = useState(0);

  useDocumentMeta({
    title: car ? `${car.display_name} self-drive rental | KSR Self Drive Cars` : 'Car | KSR Self Drive Cars',
    description: car
      ? `Rent the ${car.display_name} (${BODY_TYPE_LABELS[car.body_type]}, ${car.seats} seats, ${FUEL_LABELS[car.fuel]}) from ${formatRupees(car.price_12h_paise)} for 12 hrs or ${formatRupees(car.price_24h_paise)} for 24 hrs.`
      : undefined,
    path: `/cars/${slug}`,
  });

  if (cars.isLoading) return <SitePage><PageSpinner /></SitePage>;
  if (!car) {
    return (
      <SitePage>
        <div className="mx-auto max-w-xl px-5 py-16">
          <EmptyState title="This car isn't available" action={<Link to="/#fleet">See all cars</Link>}>
            It may have been removed from the fleet.
          </EmptyState>
        </div>
      </SitePage>
    );
  }

  const photo = car.photos[active] ?? car.photos[0];
  return (
    <SitePage>
      <div className="mx-auto max-w-[1240px] px-5 py-8 sm:px-6 md:py-14">
        <Link to="/#fleet" className="font-semibold">
          ← All cars
        </Link>
        <div className="mt-5 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] lg:gap-12">
          <div className="flex flex-col gap-3">
            <div className="relative flex aspect-[16/10] items-center justify-center overflow-hidden rounded-[18px] bg-tile">
              {car.badge && <span className="absolute top-3.5 left-3.5 z-10 rounded-full bg-white px-[11px] py-[5px] text-[13px] font-bold">{car.badge}</span>}
              {photo ? (
                <img
                  src={carPhotoUrl(photo.path)}
                  srcSet={carPhotoSrcSet(photo.path)}
                  sizes="(min-width: 1024px) 700px, 100vw"
                  width={photo.width}
                  height={photo.height}
                  alt={photo.alt}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="w-full max-w-[420px] px-8">
                  <CarImage category={car.category} />
                </div>
              )}
            </div>
            {car.photos.length > 1 && (
              <ul className="m-0 flex list-none gap-2 overflow-x-auto p-0" aria-label="Photos">
                {car.photos.map((p, i) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => setActive(i)}
                      aria-pressed={i === active}
                      aria-label={`Show photo ${i + 1}: ${p.alt}`}
                      className={cn('block h-16 w-24 overflow-hidden rounded-lg border-2', i === active ? 'border-ink' : 'border-transparent')}
                    >
                      <img src={carPhotoUrl(p.path, 400)} alt="" width={96} height={64} loading="lazy" className="h-full w-full object-cover" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex flex-col gap-5">
            <div>
              <h1 className="display m-0 text-[52px] md:text-[64px]">{car.display_name}</h1>
              <p className="m-0 mt-2 text-lg text-muted">{BODY_TYPE_LABELS[car.body_type]}</p>
            </div>
            <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-2 p-0 text-ink-2">
              <li className="flex items-center gap-1.5">
                <SeatIcon size={18} /> {car.seats} seats
              </li>
              <li className="flex items-center gap-1.5">
                <FuelIcon size={18} /> {FUEL_LABELS[car.fuel]}
              </li>
              <li className="flex items-center gap-1.5">
                <GearIcon size={18} /> {TRANSMISSION_LABELS[car.transmission]}
              </li>
            </ul>
            {car.description && <p className="m-0 text-ink-2">{car.description}</p>}
            <div className="flex flex-wrap items-end gap-8 border-t border-dashed border-line-dash pt-5">
              <div>
                <PricePlate>{formatRupees(car.price_12h_paise)}</PricePlate>
                <span className="mt-1.5 block text-sm text-muted">for 12 hrs</span>
              </div>
              <div>
                <PricePlate>{formatRupees(car.price_24h_paise)}</PricePlate>
                <span className="mt-1.5 block text-sm text-muted">for 24 hrs</span>
              </div>
            </div>
            <Button size="lg" className="self-start" onClick={() => navigate(`/book/${car.slug}`, { state: { fromHome: true } })}>
              Book this car
            </Button>
            <p className="m-0 text-sm text-muted">Fuel as per policy. Bring your original driving licence and Aadhaar (or passport/voter ID) to the pickup.</p>
          </div>
        </div>
      </div>
    </SitePage>
  );
}
