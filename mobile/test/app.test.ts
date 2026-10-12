// React Native app helpers (run by the main project's `npm test`, see vitest.config.ts).
import { describe, expect, it } from 'vitest';
import { DEFAULT_HOURS } from '../../shared/settings.ts';
import { fromIst } from '../../shared/time.ts';
import { busyKind, busyText, pickupDays } from '../src/lib/booking.ts';
import { carPhotoUrl, normalizeServerUrl, whatsappUrl } from '../src/lib/url.ts';

describe('server address', () => {
  it('accepts the live site and a computer on the Wi-Fi', () => {
    expect(normalizeServerUrl('https://ksr-self-drive-cars.onrender.com/')).toBe('https://ksr-self-drive-cars.onrender.com');
    expect(normalizeServerUrl('ksr-self-drive-cars.onrender.com')).toBe('https://ksr-self-drive-cars.onrender.com');
    expect(normalizeServerUrl(' 192.168.0.6:3000 ')).toBe('http://192.168.0.6:3000');
    expect(normalizeServerUrl('http://localhost:3000/admin')).toBe('http://localhost:3000');
  });
  it('refuses things that are not a server address', () => {
    for (const bad of ['', 'ftp://x.com', 'https://user:pw@x.com', 'not a url at all']) expect(normalizeServerUrl(bad)).toBeNull();
  });
});

describe('links', () => {
  it('builds car photo and WhatsApp links', () => {
    expect(carPhotoUrl('https://s.example', 'cars/1/abc.webp', 400)).toBe('https://s.example/media/car-photos/cars/1/abc-400.webp');
    expect(whatsappUrl('+919876543210', 'Booking KSR-1')).toBe('https://wa.me/919876543210?text=Booking%20KSR-1');
  });
});

describe('booking form', () => {
  it('lists the booking window with today, tomorrow and closed days', () => {
    const hours = { ...DEFAULT_HOURS, tue: { ...DEFAULT_HOURS.tue, closed: true } };
    const days = pickupDays('2026-10-12', 3, hours); // Monday
    expect(days.map((d) => [d.label, d.sub, d.closed])).toEqual([
      ['Today', '12 Oct', false],
      ['Tomorrow', '13 Oct', true],
      ['Wed', '14 Oct', false],
      ['Thu', '15 Oct', false],
    ]);
  });

  it('marks a car booked or in maintenance for the chosen time, including the turnaround', () => {
    const pickup = fromIst('2026-10-14', '10:00')!;
    const ret = fromIst('2026-10-14', '22:00')!;
    const busy = [
      { car_id: 'a', starts_at: fromIst('2026-10-14', '22:30')!.toISOString(), ends_at: fromIst('2026-10-15', '10:00')!.toISOString(), kind: 'booking' as const },
      { car_id: 'b', starts_at: fromIst('2026-10-14', '00:00')!.toISOString(), ends_at: fromIst('2026-10-16', '00:00')!.toISOString(), kind: 'maintenance' as const },
    ];
    expect(busyKind(busy, 'a', pickup, ret, 0)).toBeNull();
    expect(busyKind(busy, 'a', pickup, ret, 60)).toBe('booking');
    expect(busyText(busyKind(busy, 'b', pickup, ret, 0))).toBe('Not available on this date');
    expect(busyKind(busy, 'c', pickup, ret, 60)).toBeNull();
    expect(busyKind(undefined, 'a', pickup, ret, 60)).toBeNull();
  });
});
