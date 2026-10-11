// Home: hero, benefits, fleet, how it works, inline booking (desktop) and the booking
// modal/sheet at /book/:slug.
import { useEffect, useState } from 'react';
import { useLocation, useMatch, useNavigate } from 'react-router';
import { formatRupees } from '@shared/money.ts';
import { Alert } from '@/components/ui/Field';
import { PageSpinner } from '@/components/ui/Spinner';
import { track } from '@/lib/analytics';
import { errorMessage } from '@/lib/errors';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import type { PublicCar } from '@/types/db';
import { BookingOverlay } from '../booking/BookingOverlay';
import { Fleet, type FleetFilter, type Pkg } from '../components/Fleet';
import { Benefits, BookSection, cheapest, Hero, HowItWorks } from '../components/HomeSections';
import { SiteFooter, SiteHeader, StickyBookBar, useContact } from '../components/SiteChrome';
import { StructuredData } from '../components/StructuredData';
import { usePublicCars, usePublicConfig } from '../hooks/publicData';

export function HomePage() {
  const cars = usePublicCars();
  const config = usePublicConfig();
  const contact = useContact();
  const navigate = useNavigate();
  const location = useLocation();
  const bookMatch = useMatch('/book/:slug');
  const bookAny = useMatch('/book');
  const [filter, setFilter] = useState<FleetFilter>('all');
  const [pkg, setPkg] = useState<Pkg>('12h');

  const low = cars.data ? cheapest(cars.data) : undefined;
  useDocumentMeta({
    title: 'KSR Self Drive Cars | Self-drive car rental, 12 hr and 24 hr packages',
    description: `Rent a self-drive car from KSR: ${cars.data?.length ?? 11} well-maintained cars with simple 12 hr and 24 hr packages${
      low ? ` from ${formatRupees(low.price_12h_paise)}` : ''
    }. No driver, no hidden charges.`,
    path: '/',
  });

  const bookingOpen = Boolean(bookMatch || bookAny);
  const bookingCar = bookMatch ? cars.data?.find((c) => c.slug === bookMatch.params.slug) : undefined;

  // Opening the overlay is tracked here so deep links count too.
  useEffect(() => {
    if (bookingOpen && cars.data) track('booking_opened', { car_slug: bookingCar?.slug ?? 'none' });
  }, [bookingOpen, bookingCar?.slug, cars.data]);

  const openBooking = (car?: PublicCar) => navigate(car ? `/book/${car.slug}` : '/book', { state: { fromHome: true } });
  const closeBooking = () => {
    if ((location.state as { fromHome?: boolean } | null)?.fromHome) navigate(-1);
    else navigate('/', { replace: true });
  };

  return (
    <div className="flex min-h-dvh flex-col bg-page pb-[88px] md:pb-0">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-white focus:px-3 focus:py-2">
        Skip to content
      </a>
      <SiteHeader onBook={() => openBooking()} />
      <main id="main" className="flex-1">
        {cars.isLoading || config.isLoading ? (
          <PageSpinner />
        ) : cars.error || config.error ? (
          <div className="mx-auto max-w-xl p-6">
            <Alert title="We couldn't load the fleet">
              {errorMessage(cars.error ?? config.error)} {contact.phoneLabel ? `Call us on ${contact.phoneLabel} to book.` : 'Please try again.'}
            </Alert>
          </div>
        ) : (
          <>
            <Hero
              cars={cars.data!}
              contact={contact}
              onPickCategory={(c) => {
                setFilter(c);
                track('fleet_filter_used', { filter: c });
              }}
            />
            <Benefits />
            <Fleet cars={cars.data!} filter={filter} onFilter={setFilter} pkg={pkg} onPkg={setPkg} onBook={openBooking} />
            <HowItWorks carCount={cars.data!.length} address={contact.address} />
            <BookSection cars={cars.data!} config={config.data!} contact={contact} />
            <StructuredData business={config.data!.business} cars={cars.data!} />
            {bookingOpen && <BookingOverlay cars={cars.data!} config={config.data!} car={bookingCar} onClose={closeBooking} />}
          </>
        )}
      </main>
      <SiteFooter />
      <StickyBookBar onBook={() => openBooking()} />
    </div>
  );
}
