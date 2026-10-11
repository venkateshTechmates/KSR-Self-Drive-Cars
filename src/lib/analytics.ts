// Privacy-friendly analytics (Section 13). Events carry no names, phone numbers or documents.
type EventName =
  | 'fleet_viewed'
  | 'fleet_filter_used'
  | 'package_toggled'
  | 'booking_opened'
  | 'booking_submitted'
  | 'booking_failed'
  | 'call_clicked'
  | 'whatsapp_clicked';

type Props = Record<string, string | number | boolean>;

declare global {
  interface Window {
    plausible?: ((event: string, opts?: { props?: Props }) => void) & { q?: unknown[] };
  }
}

const domain = import.meta.env.VITE_PLAUSIBLE_DOMAIN;

export function initAnalytics(): void {
  if (!domain || typeof document === 'undefined' || document.getElementById('plausible-script')) return;
  window.plausible =
    window.plausible ??
    Object.assign((...args: unknown[]) => {
      (window.plausible!.q = window.plausible!.q ?? []).push(args);
    }, {});
  const s = document.createElement('script');
  s.id = 'plausible-script';
  s.defer = true;
  s.dataset.domain = domain;
  s.src = 'https://plausible.io/js/script.js';
  document.head.appendChild(s);
}

export function track(event: EventName, props?: Props): void {
  if (domain && window.plausible) window.plausible(event, props ? { props } : undefined);
  else if (import.meta.env.DEV) console.debug('[analytics]', event, props ?? '');
}
