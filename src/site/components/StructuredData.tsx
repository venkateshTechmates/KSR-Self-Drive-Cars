// AutoRental structured data (WEB-04), built from Settings and the live fleet.
import { useEffect } from 'react';
import { WEEKDAYS, type BusinessSettings } from '@shared/settings.ts';
import { formatRupees } from '@shared/money.ts';
import type { PublicCar } from '@/types/db';

const DAY_NAMES: Record<string, string> = {
  sun: 'Sunday',
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
};

export function StructuredData({ business, cars }: { business: BusinessSettings; cars: PublicCar[] }) {
  useEffect(() => {
    const site = (import.meta.env.VITE_SITE_URL ?? window.location.origin).replace(/\/$/, '');
    const prices = cars.flatMap((c) => [c.price_12h_paise, c.price_24h_paise]);
    const data: Record<string, unknown> = {
      '@context': 'https://schema.org',
      '@type': 'AutoRental',
      name: business.name || 'KSR Self Drive Cars',
      url: site,
      image: `${site}/og-image.png`,
      openingHoursSpecification: WEEKDAYS.filter((d) => !business.hours[d].closed).map((d) => ({
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: DAY_NAMES[d],
        opens: business.hours[d].open,
        closes: business.hours[d].close,
      })),
    };
    if (business.phone) data.telephone = business.phone;
    if (business.email) data.email = business.email;
    if (business.address) data.address = { '@type': 'PostalAddress', streetAddress: business.address, addressCountry: 'IN' };
    if (business.map_url) data.hasMap = business.map_url;
    if (prices.length) data.priceRange = `${formatRupees(Math.min(...prices))}–${formatRupees(Math.max(...prices))}`;

    let el = document.getElementById('ld-autorental') as HTMLScriptElement | null;
    if (!el) {
      el = document.createElement('script');
      el.type = 'application/ld+json';
      el.id = 'ld-autorental';
      document.head.appendChild(el);
    }
    el.textContent = JSON.stringify(data);
  }, [business, cars]);
  return null;
}
