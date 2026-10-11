// Header (WEB-02), footer (WEB-03), mobile sticky bar and the page shell for public pages.
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { POLICY_LABELS, POLICY_PATHS, POLICY_KINDS } from '@shared/constants.ts';
import { KsrLogo } from '@/components/brand/Brand';
import { buttonClass } from '@/components/ui/Button';
import { track } from '@/lib/analytics';
import { usePublicConfig } from '../hooks/publicData';
import { contactFrom } from './contact';
import { PhoneIcon, WhatsAppIcon } from './Icons';

export function useContact() {
  const { data } = usePublicConfig();
  return contactFrom(data?.business);
}

const YEAR = new Date().getFullYear();
const navLink = 'py-2.5 font-medium text-ink no-underline hover:text-action';

export function SiteHeader({ onBook }: { onBook?: () => void }) {
  const contact = useContact();
  return (
    <header className="border-b border-line">
      <div className="mx-auto flex max-w-[1240px] flex-wrap items-center justify-between gap-4 px-4 py-3 sm:px-6 md:py-4">
        <Link to="/" aria-label="KSR Self Drive Cars, home" className="no-underline">
          <span className="md:hidden">
            <KsrLogo size="sm" />
          </span>
          <span className="hidden md:inline">
            <KsrLogo />
          </span>
        </Link>
        <nav aria-label="Main" className="hidden flex-wrap items-center gap-x-7 gap-y-1 md:flex">
          <a href="/#fleet" className={navLink}>
            Fleet
          </a>
          <a href="/#how" className={navLink}>
            How it works
          </a>
          {onBook ? (
            <a href="/#book" className={navLink}>
              Book
            </a>
          ) : (
            <Link to="/book" className={navLink}>
              Book
            </Link>
          )}
          {contact.telHref && (
            <a href={contact.telHref} onClick={() => track('call_clicked', { location: 'header' })} className={buttonClass('secondary', 'sm', 'px-[18px] text-[16px]')}>
              <PhoneIcon size={17} />
              Call to book
            </a>
          )}
        </nav>
        {contact.telHref && (
          <a
            href={contact.telHref}
            aria-label="Call to book"
            onClick={() => track('call_clicked', { location: 'header' })}
            className="flex size-11 items-center justify-center rounded-full border-[1.5px] border-ink text-ink md:hidden"
          >
            <PhoneIcon />
          </a>
        )}
      </div>
    </header>
  );
}

export function SiteFooter() {
  const { data } = usePublicConfig();
  const contact = contactFrom(data?.business);
  const name = data?.business.name || 'KSR Self Drive Cars';
  return (
    <footer className="bg-ink text-page">
      <div className="mx-auto grid max-w-[1240px] grid-cols-1 gap-10 px-4 pt-14 pb-10 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
        <div className="flex flex-col gap-3.5">
          <span className="self-start">
            <KsrLogo withName={false} />
          </span>
          <p className="m-0 text-lg font-bold">{name}</p>
          <p className="m-0 max-w-[24em] text-night-muted">Self-drive rentals with 12 hr and 24 hr packages. Fuel as per policy.</p>
        </div>
        <div className="flex flex-col gap-2.5">
          <h2 className="m-0 mb-1 text-base font-bold">Contact</h2>
          {contact.telHref && (
            <a href={contact.telHref} onClick={() => track('call_clicked', { location: 'footer' })} className="font-semibold text-page hover:text-white">
              {contact.phoneLabel}
            </a>
          )}
          {contact.whatsappHref && (
            <a
              href={contact.whatsappHref}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => track('whatsapp_clicked', { location: 'footer' })}
              className="inline-flex items-center gap-2 text-page hover:text-white"
            >
              <WhatsAppIcon size={16} /> WhatsApp us
            </a>
          )}
          {contact.address && (
            <p className="m-0 text-night-muted">
              {contact.mapUrl ? (
                <a href={contact.mapUrl} target="_blank" rel="noopener noreferrer" className="text-night-muted hover:text-white">
                  {contact.address}
                </a>
              ) : (
                contact.address
              )}
            </p>
          )}
          {contact.hours && <p className="m-0 text-night-muted">{contact.hours}</p>}
        </div>
        <div className="flex flex-col gap-2.5">
          <h2 className="m-0 mb-1 text-base font-bold">Explore</h2>
          <a href="/#fleet" className="text-page hover:text-white">
            Our fleet
          </a>
          <a href="/#how" className="text-page hover:text-white">
            How it works
          </a>
          <Link to="/book" className="text-page hover:text-white">
            Book a car
          </Link>
          <Link to="/booking-status" className="text-page hover:text-white">
            Check a booking
          </Link>
        </div>
        <div className="flex flex-col gap-2.5">
          <h2 className="m-0 mb-1 text-base font-bold">Policies</h2>
          {POLICY_KINDS.map((k) => (
            <Link key={k} to={POLICY_PATHS[k]} className="text-page hover:text-white">
              {POLICY_LABELS[k]}
            </Link>
          ))}
        </div>
      </div>
      <div className="border-t border-night-line">
        <p className="mx-auto m-0 max-w-[1240px] px-4 py-5 text-sm text-night-muted sm:px-6">
          © {YEAR} {name}. All rights reserved.
        </p>
      </div>
    </footer>
  );
}

/** Mobile sticky bottom bar: "Call" and "Book a car" (WEB-02). */
export function StickyBookBar({ onBook }: { onBook: () => void }) {
  const contact = useContact();
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 flex gap-2.5 border-t border-line bg-surface px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] md:hidden">
      {contact.telHref && (
        <a href={contact.telHref} onClick={() => track('call_clicked', { location: 'sticky_bar' })} className={buttonClass('secondary', 'lg', 'flex-none px-5 text-base')}>
          <PhoneIcon size={17} />
          Call
        </a>
      )}
      <button type="button" onClick={onBook} className={buttonClass('primary', 'lg', 'flex-1 text-base font-bold')}>
        Book a car
      </button>
    </div>
  );
}

/** Shell for secondary public pages (policies, lookup, car detail, 404). */
export function SitePage({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-page">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-white focus:px-3 focus:py-2">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" className="flex-1">
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
