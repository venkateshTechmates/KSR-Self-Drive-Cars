// Booking request form logic (Section 5.4). The same rules run again on the server (BK-06).
import { useMemo, useState } from 'react';
import { computeReturn, packagePrice } from '@shared/booking.ts';
import { addDaysIso, availableSlots, fromIst, istDateIso, MS_HOUR, overlaps, weekdayOf } from '@shared/time.ts';
import { WEEKDAY_LABELS } from '@shared/settings.ts';
import {
  checkDl,
  MESSAGES,
  normalizeDl,
  normalizePhone,
  validateBookingRequest,
  validateEmail,
  validateName,
  validatePhone,
  validatePickup,
  type BookingField,
} from '@shared/validation.ts';
import { isSupabaseConfigured } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';
import { AppError } from '@/lib/errors';
import { callFunction } from '@/lib/functions';
import { useNow } from '@/lib/useNow';
import type { PublicCar } from '@/types/db';
import { useBusyWindows, type PublicConfig } from '../hooks/publicData';

export type Pkg = '12h' | '24h';

export interface Suggestion {
  id: string;
  slug: string;
  display_name: string;
  price_12h_paise: number;
  price_24h_paise: number;
}

export interface SentBooking {
  code: string | null;
  phone: string;
  car: PublicCar;
  pkg: Pkg;
  pickupAt: Date;
  returnAt: Date;
  pricePaise: number;
  demo: boolean;
}

type SubmitResponse =
  | { ok: true; booking_code: string | null; pickup_at?: string; return_due_at?: string; price_paise?: number; phone?: string }
  | { ok: false; error: 'clash'; message: string; suggestions: Suggestion[] };

const FIELD_ORDER: BookingField[] = ['car_id', 'package', 'pickup', 'full_name', 'phone', 'dl_number', 'email', 'consent'];
export const fieldId = (prefix: string, f: BookingField) => `${prefix}-${f.replace('_', '-')}`;

export function useBookingForm(cars: PublicCar[], config: PublicConfig, initialCarId: string | undefined, idPrefix: string) {
  const now = useNow(60_000);
  const [carId, setCarId] = useState(initialCarId ?? cars[0]?.id ?? '');
  const [pkg, setPkg] = useState<Pkg>('12h');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [dl, setDl] = useState('');
  const [email, setEmail] = useState('');
  const [consent, setConsent] = useState(false);
  const [honeypot, setHoneypot] = useState('');
  const [touched, setTouched] = useState<Partial<Record<BookingField, boolean>>>({});
  const [serverErrors, setServerErrors] = useState<Partial<Record<BookingField, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [clash, setClash] = useState<{ message: string; suggestions: Suggestion[] } | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<SentBooking | null>(null);

  const { rules, business } = config;
  const car = cars.find((c) => c.id === carId) ?? cars[0];
  const today = istDateIso(now);
  const maxDate = addDaysIso(today, rules.window_days);
  const slots = useMemo(
    () => (date ? availableSlots(date, business.hours, rules.time_step_minutes, rules.min_lead_hours, now) : []),
    [date, business.hours, rules.time_step_minutes, rules.min_lead_hours, now],
  );
  // A time that is no longer offered for the chosen date simply drops out.
  const effectiveTime = slots.includes(time) ? time : '';
  const pickupAt = date && effectiveTime ? fromIst(date, effectiveTime) : null;
  const returnAt = pickupAt ? computeReturn(pickupAt, pkg) : null;
  const price = car ? packagePrice(car, pkg) : 0;

  const dayClosed = date ? business.hours[weekdayOf(date)].closed : false;
  const noSlotsMessage = !date
    ? null
    : dayClosed
      ? MESSAGES.pickupClosed(WEEKDAY_LABELS[weekdayOf(date)])
      : slots.length === 0
        ? date === today
          ? MESSAGES.pickupTooSoon(rules.min_lead_hours)
          : 'No pickup times on this date. Choose another date.'
        : null;

  // FLE-05 / BK-10 hint: cars busy (booked or in maintenance) for the chosen time.
  const busy = useBusyWindows(pickupAt ? pickupAt.toISOString() : null, returnAt ? new Date(returnAt.getTime() + rules.turnaround_buffer_minutes * 60_000).toISOString() : null);
  const unavailable = useMemo(() => {
    const out = new Map<string, 'booking' | 'maintenance'>();
    if (!pickupAt || !returnAt || !busy.data) return out;
    const end = new Date(returnAt.getTime() + rules.turnaround_buffer_minutes * 60_000);
    for (const w of busy.data) if (overlaps(pickupAt, end, w.starts_at, w.ends_at)) out.set(w.car_id, out.get(w.car_id) === 'maintenance' ? 'maintenance' : w.kind);
    return out;
  }, [busy.data, pickupAt, returnAt, rules.turnaround_buffer_minutes]);

  const pickupCtx = { rules, hours: business.hours, now };
  const clientErrors: Partial<Record<BookingField, string>> = {
    car_id: car ? undefined : MESSAGES.carRequired,
    pickup: validatePickup(date, effectiveTime, pickupCtx) ?? undefined,
    full_name: validateName(name) ?? undefined,
    phone: validatePhone(phone) ?? undefined,
    dl_number: checkDl(dl).error ?? undefined,
    email: validateEmail(email) ?? undefined,
    consent: consent ? undefined : MESSAGES.consentRequired,
  };
  const errorFor = (f: BookingField) => serverErrors[f] ?? (touched[f] ? clientErrors[f] : undefined);
  const dlWarning = dl && !checkDl(dl).error && checkDl(dl).oldFormat ? MESSAGES.dlOldFormat : null;

  const touch = (f: BookingField) => setTouched((t) => ({ ...t, [f]: true }));
  const clearServer = (f: BookingField) => setServerErrors((e) => (e[f] ? { ...e, [f]: undefined } : e));

  function focusFirstError(errors: Partial<Record<BookingField, string>>) {
    const first = FIELD_ORDER.find((f) => errors[f]);
    if (!first) return;
    const target = first === 'pickup' ? (date ? fieldId(idPrefix, 'pickup') + '-time' : fieldId(idPrefix, 'pickup') + '-date') : fieldId(idPrefix, first);
    requestAnimationFrame(() => document.getElementById(target)?.focus());
  }

  async function submit() {
    setFormError(null);
    setClash(null);
    const input = {
      car_id: car?.id ?? '',
      package: pkg,
      pickup_date: date,
      pickup_time: effectiveTime,
      full_name: name,
      phone,
      dl_number: dl,
      email,
      consent,
      website: honeypot,
    };
    const v = validateBookingRequest(input, pickupCtx);
    if (!v.ok) {
      setTouched(Object.fromEntries(FIELD_ORDER.map((f) => [f, true])));
      focusFirstError(v.errors);
      track('booking_failed', { reason: 'validation' });
      return;
    }
    const leadHours = Math.round((v.value.pickup_at.getTime() - Date.now()) / MS_HOUR);
    const base = { phone: v.value.phone, car: car!, pkg, pickupAt: v.value.pickup_at, returnAt: computeReturn(v.value.pickup_at, pkg), pricePaise: price };

    if (!isSupabaseConfigured) {
      setSent({ ...base, code: null, demo: true });
      return;
    }
    setSending(true);
    try {
      const res = await callFunction<SubmitResponse>('submit-booking', { anonymous: true, body: { ...input, pickup_time: effectiveTime, locale: 'en' } });
      if (res.ok) {
        setSent({ ...base, code: res.booking_code, demo: false });
        track('booking_submitted', { car_slug: car!.slug, package: pkg, lead_time_hours: leadHours });
      } else {
        setClash({ message: res.message || MESSAGES.carClash, suggestions: res.suggestions ?? [] });
        track('booking_failed', { reason: 'clash' });
      }
    } catch (err) {
      const e = err instanceof AppError ? err : new AppError(MESSAGES.network, 'network');
      if (e.code === 'validation' && e.hint && typeof e.hint === 'object') {
        setServerErrors(e.hint as Partial<Record<BookingField, string>>);
        focusFirstError(e.hint as Partial<Record<BookingField, string>>);
        track('booking_failed', { reason: 'validation' });
      } else if (e.code === 'rate_limited' || e.status === 429) {
        setFormError(MESSAGES.tooManyRequests);
        track('booking_failed', { reason: 'rate_limit' });
      } else if (e.code && (FIELD_ORDER as string[]).includes(e.code)) {
        // SQL check failed for one field (e.g. pickup rules changed since the page loaded).
        setServerErrors({ [e.code]: e.message });
        focusFirstError({ [e.code]: e.message });
        track('booking_failed', { reason: 'validation' });
      } else {
        // BK-16: keep everything typed and let them retry.
        setFormError(e.code === 'network' ? MESSAGES.network : e.message || MESSAGES.network);
        track('booking_failed', { reason: 'network' });
      }
    } finally {
      setSending(false);
    }
  }

  function reset() {
    setSent(null);
    setDate('');
    setTime('');
    setConsent(false);
    setTouched({});
    setServerErrors({});
    setClash(null);
    setFormError(null);
  }

  return {
    config,
    // values
    car,
    carId: car?.id ?? '',
    pkg,
    date,
    time: effectiveTime,
    name,
    phone,
    dl,
    email,
    consent,
    honeypot,
    // derived
    today,
    maxDate,
    slots,
    noSlotsMessage,
    pickupAt,
    returnAt,
    price,
    unavailable,
    dlWarning,
    errorFor,
    // status
    sending,
    sent,
    formError,
    clash,
    // setters
    setCar: (id: string) => {
      setCarId(id);
      setClash(null);
      clearServer('car_id');
    },
    setPkg,
    setDate: (v: string) => {
      setDate(v);
      setClash(null);
      clearServer('pickup');
    },
    setTime: (v: string) => {
      setTime(v);
      setClash(null);
      clearServer('pickup');
      touch('pickup');
    },
    setName: (v: string) => (setName(v), clearServer('full_name')),
    setPhone: (v: string) => (setPhone(v), clearServer('phone')),
    setDl: (v: string) => (setDl(v.toUpperCase()), clearServer('dl_number')),
    setEmail: (v: string) => (setEmail(v), clearServer('email')),
    setConsent: (v: boolean) => (setConsent(v), touch('consent'), clearServer('consent')),
    setHoneypot,
    blur: (f: BookingField) => {
      touch(f);
      if (f === 'dl_number' && dl) setDl(normalizeDl(dl));
      if (f === 'phone' && phone && normalizePhone(phone)) setPhone(phone.trim());
    },
    submit,
    reset,
  };
}

export type BookingFormState = ReturnType<typeof useBookingForm>;
