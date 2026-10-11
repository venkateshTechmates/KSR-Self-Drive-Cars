import { WEEKDAYS, type BusinessSettings, type OpeningHours, type Weekday } from '@shared/settings.ts';
import { formatClock } from '@shared/time.ts';
import { formatPhone } from '@shared/validation.ts';
import { whatsappHref } from '@/lib/format';

const SHORT: Record<Weekday, string> = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' };
const ORDER: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** "Open every day, 8:00 am – 8:00 pm" or "Mon–Sat 8:00 am – 8:00 pm · Sun closed". */
export function hoursSummary(hours: OpeningHours): string {
  const key = (d: Weekday) => (hours[d].closed ? 'closed' : `${hours[d].open}-${hours[d].close}`);
  const text = (d: Weekday) => (hours[d].closed ? 'closed' : `${formatClock(hours[d].open)} – ${formatClock(hours[d].close)}`);
  if (WEEKDAYS.every((d) => key(d) === key('mon')) && !hours.mon.closed) return `Open every day, ${text('mon')}`;
  const groups: Array<{ from: Weekday; to: Weekday; k: string }> = [];
  for (const d of ORDER) {
    const last = groups[groups.length - 1];
    if (last && last.k === key(d)) last.to = d;
    else groups.push({ from: d, to: d, k: key(d) });
  }
  return groups.map((g) => `${SHORT[g.from]}${g.from !== g.to ? `–${SHORT[g.to]}` : ''} ${text(g.from)}`).join(' · ');
}

export interface Contact {
  phone: string | null;
  phoneLabel: string | null;
  telHref: string | undefined;
  whatsappHref: string | undefined;
  address: string | null;
  mapUrl: string | null;
  hours: string;
}

/** Contact details from Settings (SET-01). Calls/WhatsApp are hidden until a number is set (gap G4). */
export function contactFrom(b: BusinessSettings | undefined): Contact {
  const phone = b?.phone || null;
  return {
    phone,
    phoneLabel: phone ? formatPhone(phone) : null,
    telHref: phone ? `tel:${phone}` : undefined,
    whatsappHref: b?.whatsapp ? whatsappHref(b.whatsapp, 'Hi KSR Self Drive Cars, I would like to book a car.') : undefined,
    address: b?.address || null,
    mapUrl: b?.map_url || null,
    hours: b ? hoursSummary(b.hours) : '',
  };
}
