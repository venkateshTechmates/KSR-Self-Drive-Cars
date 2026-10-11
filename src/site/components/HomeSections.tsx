// Home page sections from the design canvas: hero (HOM-01..03), benefits (HOM-04),
// how it works (HOM-05) and the inline "Book a car" section.
import { CATEGORY_LABELS, CAR_CATEGORIES, type CarCategory } from '@shared/constants.ts';
import { formatRupees } from '@shared/money.ts';
import { BigPlate } from '@/components/brand/Brand';
import { buttonClass } from '@/components/ui/Button';
import { track } from '@/lib/analytics';
import type { PublicCar } from '@/types/db';
import type { PublicConfig } from '../hooks/publicData';
import { BookingForm } from '../booking/BookingForm';
import type { Contact } from './contact';
import { ChevronRight, ClockIcon, KeyIcon, PhoneIcon, ShieldIcon, WhatsAppIcon } from './Icons';

export function cheapest(cars: PublicCar[]): PublicCar | undefined {
  return [...cars].sort((a, b) => a.price_12h_paise - b.price_12h_paise)[0];
}

export function Hero({ cars, contact, onPickCategory }: { cars: PublicCar[]; contact: Contact; onPickCategory: (c: CarCategory) => void }) {
  const low = cheapest(cars);
  const from = low ? formatRupees(low.price_12h_paise) : null;
  const rates = CAR_CATEGORIES.map((cat) => {
    const inCat = cars.filter((c) => c.category === cat);
    return inCat.length ? { cat, from: formatRupees(Math.min(...inCat.map((c) => c.price_12h_paise))) } : null;
  }).filter(Boolean) as Array<{ cat: CarCategory; from: string }>;

  return (
    <section id="top" className="mx-auto flex max-w-[1240px] flex-col gap-5 px-5 pt-7 pb-8 sm:px-6 md:gap-12 md:pt-16 md:pb-20">
      <h1 className="display m-0 max-w-[13em] text-[56px] leading-[0.9] tracking-[-0.012em] md:text-[clamp(60px,8.2vw,118px)]">
        Your car, your schedule, your price.
      </h1>
      <div className="grid grid-cols-1 items-start gap-5 md:grid-cols-[repeat(auto-fit,minmax(min(100%,420px),1fr))] md:gap-14">
        <div className="flex flex-col gap-7">
          <p className="m-0 max-w-[30em] text-base text-ink-2 md:text-xl md:leading-normal">
            {cars.length} well-maintained cars with simple 12 hr and 24 hr pricing{from ? `, from ${from}` : ''}. No hidden charges, no driver, full
            freedom.
          </p>
          <div className="hidden flex-wrap gap-3 md:flex">
            <a href="#fleet" className={buttonClass('primary', 'lg', 'px-[26px]')}>
              Browse the fleet
            </a>
            {contact.telHref && (
              <a href={contact.telHref} onClick={() => track('call_clicked', { location: 'hero' })} className={buttonClass('secondary', 'lg', 'px-6')}>
                <PhoneIcon /> Call to book
              </a>
            )}
            {contact.whatsappHref && (
              <a
                href={contact.whatsappHref}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => track('whatsapp_clicked', { location: 'hero' })}
                className={buttonClass('ghost', 'lg', 'px-5')}
              >
                <WhatsAppIcon /> WhatsApp
              </a>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-7">
          {from && low && (
            <div className="flex flex-col gap-3">
              <BigPlate size="xl" tilt label={`Rental plate reading: from ${from}`} className="mt-1.5 self-start md:self-stretch">
                FROM {from}
              </BigPlate>
              <p className="m-0 hidden text-sm text-muted md:block">12 hr package on the {low.display_name}.</p>
            </div>
          )}
          {rates.length > 0 && (
            <div className="hidden flex-col md:flex">
              <p className="m-0 mb-1 text-[15px] font-bold">Starting prices for 12 hrs</p>
              {rates.map((r) => (
                <a
                  key={r.cat}
                  href="#fleet"
                  onClick={() => onPickCategory(r.cat)}
                  className="flex min-h-14 items-center justify-between gap-4 border-b border-[#C2C8C2] text-ink no-underline hover:text-action"
                >
                  <span className="text-lg font-medium">{CATEGORY_LABELS[r.cat]}</span>
                  <span className="flex items-center gap-2.5 text-lg font-bold">
                    from {r.from}
                    <ChevronRight />
                  </span>
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

const BENEFITS = [
  { icon: ClockIcon, title: 'Flexible hours', long: '12 hr and 24 hr packages. Pay only for the time you need.', short: '12 hr and 24 hr packages.' },
  { icon: ShieldIcon, title: 'Well maintained', long: 'Every car is serviced, sanitised and checked before each trip.', short: 'Serviced, sanitised and checked before each trip.' },
  { icon: KeyIcon, title: 'Quick handover', long: 'Minimal paperwork. Show your licence, take the keys, drive.', short: 'Show your licence, take the keys, drive.' },
];

export function Benefits() {
  return (
    <section aria-label="Why KSR" className="border-y border-line bg-subtle">
      <div className="mx-auto grid max-w-[1240px] grid-cols-1 gap-4 px-5 py-5 sm:px-6 md:grid-cols-3 md:gap-8 md:py-10">
        {BENEFITS.map((b) => (
          <div key={b.title} className="flex items-start gap-3 md:gap-4">
            <span className="hidden size-12 flex-none items-center justify-center rounded-full border border-line bg-white text-ink md:flex">
              <b.icon />
            </span>
            <b.icon className="mt-px flex-none md:hidden" />
            <div>
              <h2 className="m-0 hidden text-lg font-bold md:block">{b.title}</h2>
              <p className="m-0 mt-1 hidden text-ink-3 md:block">{b.long}</p>
              <p className="m-0 md:hidden">
                <strong>{b.title}.</strong> {b.short}
              </p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function HowItWorks({ carCount, address }: { carCount: number; address: string | null }) {
  const where = address ? `Collect the car at ${address}.` : 'Collect the car at our pickup point.';
  const steps = [
    { title: 'Pick a car and package', text: `Choose from ${carCount} cars, then a 12 hr or 24 hr package. No hidden charges.`, short: '12 hr or 24 hr. No hidden charges.' },
    { title: 'Call or send a request', text: 'Call us to book, or send a booking request and we call you back to confirm.', short: 'We call you back to confirm.' },
    { title: 'Show your licence, take the keys', text: `${where} Fuel as per policy.`, short: `${where} Fuel as per policy.` },
  ];
  return (
    <section id="how" aria-labelledby="how-heading" className="border-y border-line bg-white">
      <div className="mx-auto max-w-[1240px] px-5 py-8 sm:px-6 md:py-[88px]">
        <h2 id="how-heading" className="display m-0 text-[44px] md:text-[clamp(48px,5.4vw,76px)]">
          How it works
        </h2>
        <ol className="m-0 mt-5 grid list-none grid-cols-1 gap-[18px] p-0 md:mt-11 md:grid-cols-3 md:gap-8">
          {steps.map((s, i) => (
            <li key={s.title} className="flex items-start gap-4 md:flex-col md:gap-3 md:border-t-[3px] md:border-ink md:pt-5">
              <span aria-hidden="true" className="display w-7 flex-none text-[40px] leading-none md:w-auto md:text-[60px]">
                {i + 1}
              </span>
              <div>
                <h3 className="m-0 text-[17px] font-bold md:text-[21px]">{s.title}</h3>
                <p className="m-0 mt-0.5 max-w-[26em] text-ink-3 md:mt-3">
                  <span className="hidden md:inline">{s.text}</span>
                  <span className="md:hidden">{s.short}</span>
                </p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/** Desktop inline booking section (design "Book a car"). Phones use the full-screen sheet. */
export function BookSection({ cars, config, contact }: { cars: PublicCar[]; config: PublicConfig; contact: Contact }) {
  return (
    <section id="book" aria-labelledby="book-heading" className="mx-auto hidden max-w-[1240px] px-6 py-24 md:block">
      <div className="mb-7 flex flex-col gap-3">
        <h2 id="book-heading" className="display m-0 text-[clamp(48px,5.4vw,76px)]">
          Book a car
        </h2>
        <p className="m-0 max-w-[30em] text-lg text-ink-2">
          Send a request and we call you to confirm.
          {contact.telHref && (
            <>
              {' '}
              Prefer to talk?{' '}
              <a href={contact.telHref} onClick={() => track('call_clicked', { location: 'book_section' })} className="font-semibold">
                Call to book
              </a>
              .
            </>
          )}
        </p>
      </div>
      <BookingForm cars={cars} config={config} variant="section" idPrefix="bs" />
    </section>
  );
}
