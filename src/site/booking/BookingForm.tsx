// Booking request form (Section 5.4): inline on the desktop home page, and inside the
// booking modal (desktop) / full-screen sheet (mobile).
import type { InputHTMLAttributes, ReactNode } from 'react';
import { Link } from 'react-router';
import { BODY_TYPE_LABELS, FUEL_LABELS, TRANSMISSION_LABELS } from '@shared/constants.ts';
import { formatRupees } from '@shared/money.ts';
import { formatClock, formatWhen } from '@shared/time.ts';
import { formatPhone, MESSAGES } from '@shared/validation.ts';
import { BigPlate, CarImage, PricePlate } from '@/components/brand/Brand';
import { Button, buttonClass } from '@/components/ui/Button';
import { Alert, controlClass } from '@/components/ui/Field';
import { track } from '@/lib/analytics';
import { cn } from '@/lib/cn';
import type { PublicCar } from '@/types/db';
import type { PublicConfig } from '../hooks/publicData';
import { contactFrom } from '../components/contact';
import { CheckCircle, PhoneIcon, WhatsAppIcon } from '../components/Icons';
import { fieldId, useBookingForm, type BookingFormState, type Pkg } from './useBookingForm';

interface Props {
  cars: PublicCar[];
  config: PublicConfig;
  initialCarId?: string;
  /** 'section' = inline desktop section; 'sheet' = modal (desktop) / full-screen sheet (mobile). */
  variant: 'section' | 'sheet';
  idPrefix: string;
  onDone?: () => void;
}

export function BookingForm({ cars, config, initialCarId, variant, idPrefix, onDone }: Props) {
  const f = useBookingForm(cars, config, initialCarId, idPrefix);
  const contact = contactFrom(config.business);

  if (f.sent) return <Confirmation f={f} contact={contact} variant={variant} onDone={onDone} />;
  if (!f.car) return <Alert tone="info">No cars are available to book right now. Please call us.</Alert>;

  const id = (field: Parameters<typeof fieldId>[1]) => fieldId(idPrefix, field);

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void f.submit();
      }}
      className={cn(variant === 'sheet' && 'flex min-h-0 flex-1 flex-col')}
    >
      <div
        className={cn(
          'grid items-start gap-10',
          variant === 'section' ? 'grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]' : 'grid-cols-1 md:grid-cols-[minmax(0,1fr)_340px] md:gap-8',
          variant === 'sheet' && 'min-h-0 flex-1 overflow-y-auto px-5 pt-5 pb-7 md:px-7',
        )}
      >
        <div className="flex min-w-0 flex-col gap-[22px] md:gap-[22px]">
          <CarField f={f} cars={cars} id={id('car_id')} variant={variant} />
          <PackageField f={f} name={`${idPrefix}-pkg`} />
          <PickupFields f={f} idPrefix={idPrefix} />
          <DetailsFields f={f} id={id} />

          <p className="m-0 text-sm text-ink-3">
            Bring your original driving licence and Aadhaar (or passport/voter ID) to the handover. Fuel as per policy.
          </p>

          {/* Honeypot: hidden from people and assistive tech; bots fill it. */}
          <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
            <label htmlFor={`${idPrefix}-website`}>Website</label>
            <input id={`${idPrefix}-website`} name="website" tabIndex={-1} autoComplete="off" value={f.honeypot} onChange={(e) => f.setHoneypot(e.target.value)} />
          </div>

          <ConsentField f={f} id={id('consent')} />

          {f.clash && <ClashNotice f={f} cars={cars} />}
          {f.formError && <Alert>{f.formError}</Alert>}

          <div className={cn(variant === 'sheet' && 'hidden md:block')}>
            <Button type="submit" size="lg" loading={f.sending} loadingText="Sending…" className="px-[30px] font-bold">
              Request booking
            </Button>
          </div>
        </div>

        <div className={cn(variant === 'sheet' ? 'hidden md:block' : 'hidden lg:block', 'lg:sticky lg:top-6')}>
          <Summary f={f} />
        </div>
      </div>

      {variant === 'sheet' && (
        <div className="flex flex-none items-center gap-3.5 border-t border-line bg-surface px-4 pt-3 pb-[max(22px,env(safe-area-inset-bottom))] md:hidden">
          <div className="flex flex-none flex-col gap-1">
            <span className="text-xs text-muted">
              {f.car.display_name}, {f.pkg === '12h' ? '12' : '24'} hrs
            </span>
            <PricePlate size="sm" className="text-[24px]">
              {formatRupees(f.price)}
            </PricePlate>
          </div>
          <Button type="submit" size="lg" loading={f.sending} loadingText="Sending…" className="min-h-[54px] flex-1 text-base font-bold">
            Request booking
          </Button>
        </div>
      )}
    </form>
  );
}

// ------------------------------------------------------------------ fields

function FieldShell({ label, htmlFor, error, hint, children, as = 'div' }: { label: ReactNode; htmlFor?: string; error?: string | null; hint?: ReactNode; children: ReactNode; as?: 'div' | 'fieldset' }) {
  const Tag = as;
  return (
    <Tag className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
      {as === 'fieldset' ? (
        <legend className="mb-2 p-0 font-semibold">{label}</legend>
      ) : (
        <label htmlFor={htmlFor} className="font-semibold">
          {label}
        </label>
      )}
      {children}
      {hint && <p className="m-0 text-sm text-muted">{hint}</p>}
      {error && (
        <p id={htmlFor ? `${htmlFor}-error` : undefined} className="m-0 text-sm font-semibold text-danger">
          {error}
        </p>
      )}
    </Tag>
  );
}

const carLabel = (c: PublicCar) => `${c.display_name} (${BODY_TYPE_LABELS[c.body_type]})`;
const unavailableText = (kind: 'booking' | 'maintenance' | undefined) =>
  kind === 'maintenance' ? 'Not available on this date' : kind === 'booking' ? 'Booked at this time' : null;

function CarField({ f, cars, id, variant }: { f: BookingFormState; cars: PublicCar[]; id: string; variant: Props['variant'] }) {
  const err = f.errorFor('car_id');
  const note = unavailableText(f.unavailable.get(f.carId));
  return (
    <>
      {/* Desktop: select (design) */}
      <div className={cn(variant === 'sheet' ? 'hidden md:block' : 'block')}>
        <FieldShell label="Car" htmlFor={id} error={err ?? note}>
          <select id={id} value={f.carId} onChange={(e) => f.setCar(e.target.value)} className={controlClass(Boolean(err), 'pr-8')} aria-describedby={err || note ? `${id}-error` : undefined}>
            {cars.map((c) => (
              <option key={c.id} value={c.id}>
                {carLabel(c)}
                {f.unavailable.has(c.id) ? ` — ${unavailableText(f.unavailable.get(c.id))}` : ''}
              </option>
            ))}
          </select>
        </FieldShell>
      </div>
      {/* Mobile sheet: car carousel (design) */}
      {variant === 'sheet' && (
        <section aria-labelledby={`${id}-heading`} className="flex flex-col gap-3 md:hidden">
          <h2 id={`${id}-heading`} className="m-0 text-base font-bold">
            Car
          </h2>
          <div role="group" aria-labelledby={`${id}-heading`} className="-mx-5 flex gap-2.5 overflow-x-auto px-5 pt-0.5 pb-1.5">
            {cars.map((c) => {
              const on = c.id === f.carId;
              const busy = unavailableText(f.unavailable.get(c.id));
              return (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => f.setCar(c.id)}
                  className={cn(
                    'flex w-[136px] flex-none flex-col gap-2 rounded-[14px] border-2 p-2 pb-2.5 text-left text-ink',
                    on ? 'border-ink bg-white' : 'border-line-card bg-subtle',
                  )}
                >
                  <span className="flex h-16 items-center justify-center overflow-hidden rounded-[9px] bg-tile px-1.5 pt-2 pb-1">
                    <CarImage photo={c.photos[0]} category={c.category} sizes="120px" />
                  </span>
                  <span className="text-sm leading-tight font-bold">{c.display_name}</span>
                  <span className="text-[13px] text-ink-3">from {formatRupees(c.price_12h_paise)}</span>
                  {busy && <span className="text-[12px] font-semibold text-danger">{busy}</span>}
                </button>
              );
            })}
          </div>
          <p className="m-0 text-sm text-ink-2">
            {f.car!.display_name}: {BODY_TYPE_LABELS[f.car!.body_type]}, {f.car!.seats} seats, {FUEL_LABELS[f.car!.fuel]},{' '}
            {TRANSMISSION_LABELS[f.car!.transmission].toLowerCase()}
          </p>
          {note && <p className="m-0 text-sm font-semibold text-danger">{note}</p>}
        </section>
      )}
    </>
  );
}

function PackageField({ f, name }: { f: BookingFormState; name: string }) {
  const option = (pkg: Pkg, label: string, paise: number) => (
    <label
      className={cn(
        'flex min-h-[60px] cursor-pointer items-center gap-3 rounded-xl border-2 bg-white px-4',
        f.pkg === pkg ? 'border-ink' : 'border-[#C6CBC5]',
      )}
    >
      <input type="radio" name={name} value={pkg} checked={f.pkg === pkg} onChange={() => f.setPkg(pkg)} className="m-0 size-[18px] accent-ink" />
      <span>
        <span className="block font-bold">{label}</span>
        <span className="block text-sm text-muted">
          {formatRupees(paise)} for {label}
        </span>
      </span>
    </label>
  );
  return (
    <FieldShell label="Package" as="fieldset">
      <div className="grid grid-cols-2 gap-2.5">
        {option('12h', '12 hrs', f.car!.price_12h_paise)}
        {option('24h', '24 hrs', f.car!.price_24h_paise)}
      </div>
    </FieldShell>
  );
}

function PickupFields({ f, idPrefix }: { f: BookingFormState; idPrefix: string }) {
  const base = fieldId(idPrefix, 'pickup');
  const err = f.errorFor('pickup');
  const describedBy = err ? `${base}-error` : `${base}-hint`;
  return (
    <section aria-labelledby={`${base}-heading`} className="flex flex-col gap-3">
      <h2 id={`${base}-heading`} className="sr-only">
        Pickup
      </h2>
      <div className="grid grid-cols-1 gap-4 min-[420px]:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-2">
          <label htmlFor={`${base}-date`} className="font-semibold">
            Pickup date
          </label>
          <input
            id={`${base}-date`}
            type="date"
            min={f.today}
            max={f.maxDate}
            value={f.date}
            onChange={(e) => f.setDate(e.target.value)}
            onBlur={() => f.blur('pickup')}
            aria-invalid={err ? true : undefined}
            aria-describedby={describedBy}
            className={controlClass(Boolean(err))}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <label htmlFor={`${base}-time`} className="font-semibold">
            Pickup time
          </label>
          <select
            id={`${base}-time`}
            value={f.time}
            onChange={(e) => f.setTime(e.target.value)}
            onBlur={() => f.blur('pickup')}
            disabled={!f.date || f.slots.length === 0}
            aria-invalid={err ? true : undefined}
            aria-describedby={describedBy}
            className={controlClass(Boolean(err), 'pr-8')}
          >
            <option value="">{f.date ? (f.slots.length ? 'Choose a time' : 'No times') : 'Choose a date first'}</option>
            {f.slots.map((s) => (
              <option key={s} value={s}>
                {formatClock(s)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {f.noSlotsMessage && !err && <p className="m-0 text-sm font-semibold text-danger">{f.noSlotsMessage}</p>}
      {err ? (
        <p id={`${base}-error`} className="m-0 text-sm font-semibold text-danger">
          {err}
        </p>
      ) : (
        <p id={`${base}-hint`} className="m-0 text-sm text-muted">
          Pickups need at least {f.config.rules.min_lead_hours} hours&apos; notice, in {f.config.rules.time_step_minutes}-minute steps.
        </p>
      )}
      <div className="flex justify-between gap-3 rounded-xl border border-dashed border-[#B5BCB6] bg-subtle px-3.5 py-3">
        <span className="text-ink-3">Return by</span>
        <span className="text-right font-bold" aria-live="polite">
          {f.returnAt ? formatWhen(f.returnAt) : 'Set by your pickup time'}
        </span>
      </div>
    </section>
  );
}

function DetailsFields({ f, id }: { f: BookingFormState; id: (field: Parameters<typeof fieldId>[1]) => string }) {
  const input = (
    field: 'full_name' | 'phone' | 'dl_number' | 'email',
    label: string,
    value: string,
    onChange: (v: string) => void,
    extra: InputHTMLAttributes<HTMLInputElement>,
    hint?: ReactNode,
  ) => {
    const err = f.errorFor(field);
    const fid = id(field);
    return (
      <div className="flex min-w-0 flex-col gap-2">
        <label htmlFor={fid} className="font-semibold">
          {label}
          {field === 'email' && <span className="font-normal text-muted"> (optional)</span>}
        </label>
        <input
          id={fid}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => f.blur(field)}
          aria-invalid={err ? true : undefined}
          aria-describedby={[err ? `${fid}-error` : null, hint ? `${fid}-hint` : null].filter(Boolean).join(' ') || undefined}
          className={controlClass(Boolean(err))}
          {...extra}
        />
        {hint && !err && (
          <p id={`${fid}-hint`} className="m-0 text-sm text-muted">
            {hint}
          </p>
        )}
        {err && (
          <p id={`${fid}-error`} className="m-0 text-sm font-semibold text-danger">
            {err}
          </p>
        )}
      </div>
    );
  };
  return (
    <section aria-label="Your details" className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {input('full_name', 'Full name', f.name, f.setName, { type: 'text', autoComplete: 'name', maxLength: 80 })}
        {input('phone', 'Mobile number', f.phone, f.setPhone, { type: 'tel', autoComplete: 'tel', inputMode: 'tel', placeholder: '98765 43210' })}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {input(
          'dl_number',
          'Driving licence number',
          f.dl,
          f.setDl,
          { type: 'text', autoComplete: 'off', autoCapitalize: 'characters', spellCheck: false, maxLength: 24, placeholder: 'TS0920110012345' },
          f.dlWarning ?? 'As printed on your licence.',
        )}
        {input('email', 'Email', f.email, f.setEmail, { type: 'email', autoComplete: 'email' })}
      </div>
    </section>
  );
}

function ConsentField({ f, id }: { f: BookingFormState; id: string }) {
  const err = f.errorFor('consent');
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-line bg-subtle p-3.5">
      <label htmlFor={id} className="flex cursor-pointer items-start gap-3">
        <input
          id={id}
          type="checkbox"
          checked={f.consent}
          onChange={(e) => f.setConsent(e.target.checked)}
          aria-invalid={err ? true : undefined}
          aria-describedby={err ? `${id}-error` : undefined}
          className="mt-0.5 size-5 shrink-0 accent-ink"
        />
        <span className="text-[15px] leading-snug">
          I agree that KSR Self Drive Cars can use my name, mobile number and driving licence details to process this booking, verify my identity at
          pickup, and handle any fines or damage linked to this rental.{' '}
          <Link to="/privacy" target="_blank" rel="noopener">
            Read the privacy notice
          </Link>
        </span>
      </label>
      {err && (
        <p id={`${id}-error`} className="m-0 pl-8 text-sm font-semibold text-danger">
          {err}
        </p>
      )}
    </div>
  );
}

function ClashNotice({ f, cars }: { f: BookingFormState; cars: PublicCar[] }) {
  const suggestions = f.clash!.suggestions.filter((s) => cars.some((c) => c.id === s.id));
  return (
    <Alert title={f.clash!.message || MESSAGES.carClash}>
      {suggestions.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          <span className="text-ink-2">These cars are free at that time:</span>
          <div className="flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <button key={s.id} type="button" onClick={() => f.setCar(s.id)} className={buttonClass('secondary', 'sm', 'bg-white')}>
                {s.display_name} · {formatRupees(f.pkg === '12h' ? s.price_12h_paise : s.price_24h_paise)}
              </button>
            ))}
          </div>
        </div>
      )}
    </Alert>
  );
}

/** Live summary (BK-01). */
function Summary({ f }: { f: BookingFormState }) {
  const rows: Array<[string, string]> = [
    ['Car', f.car!.display_name],
    ['Package', f.pkg === '12h' ? '12 hrs' : '24 hrs'],
    ['Pickup', f.pickupAt ? formatWhen(f.pickupAt) : 'Choose date and time'],
    ['Return by', f.returnAt ? formatWhen(f.returnAt) : 'Set by your pickup time'],
    ['Fuel', 'As per policy'],
  ];
  return (
    <aside aria-label="Your booking" className="flex flex-col gap-[22px] rounded-[20px] bg-ink p-7 text-night-text">
      <p className="m-0 text-lg font-bold">Your booking</p>
      <div className="self-start" aria-live="polite">
        <BigPlate label={`Total ${formatRupees(f.price)}`}>{formatRupees(f.price)}</BigPlate>
      </div>
      <dl className="m-0 flex flex-col">
        {rows.map(([k, v], i) => (
          <div key={k} className={cn('flex justify-between gap-4 py-3', i < rows.length - 1 && 'border-b border-night-line')}>
            <dt className="text-night-muted">{k}</dt>
            <dd className="m-0 text-right font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="m-0 text-sm text-[#C9CFCC]">{f.config.rules.fuel_policy || 'Bring your driving licence to the handover.'}</p>
    </aside>
  );
}

// ------------------------------------------------------------------ confirmation (BK-12)

function Confirmation({
  f,
  contact,
  variant,
  onDone,
}: {
  f: BookingFormState;
  contact: ReturnType<typeof contactFrom>;
  variant: Props['variant'];
  onDone?: () => void;
}) {
  const s = f.sent!;
  return (
    <div role="status" className={cn('flex flex-col gap-[18px]', variant === 'sheet' && 'overflow-y-auto px-6 pt-9 pb-7 md:px-8')}>
      <CheckCircle size={48} className="text-action" />
      <h2 className="display m-0 text-[44px] leading-[0.95]">Request sent</h2>
      <p className="m-0 text-base text-ink-2">
          {s.code ? (
            <>
              Your booking code is <strong className="font-mono">{s.code}</strong>.{' '}
            </>
          ) : null}
          We&apos;ll call you on <strong>{formatPhone(s.phone)}</strong> to confirm.
        </p>
      <div className="flex flex-col gap-3.5 rounded-[18px] bg-ink p-5 text-night-text">
        <div className="self-start">
          <BigPlate size="md">{formatRupees(s.pricePaise)}</BigPlate>
        </div>
        <dl className="m-0 flex flex-col">
          {(
            [
              ['Car', s.car.display_name],
              ['Package', s.pkg === '12h' ? '12 hrs' : '24 hrs'],
              ['Pickup', formatWhen(s.pickupAt)],
              ['Return by', formatWhen(s.returnAt)],
            ] as const
          ).map(([k, v], i) => (
            <div key={k} className={cn('flex justify-between gap-3 py-2.5', i < 3 && 'border-b border-night-line')}>
              <dt className="text-night-muted">{k}</dt>
              <dd className="m-0 text-right font-semibold">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div>
        <h3 className="m-0 text-base font-bold">What to bring</h3>
        <p className="m-0 mt-1 text-ink-2">
          Bring your original driving licence and Aadhaar (or passport/voter ID). We&apos;ll verify them at pickup and hand you the keys.
        </p>
      </div>
      <div className="mt-1 flex flex-col gap-2.5 sm:flex-row sm:flex-wrap">
        {contact.telHref && (
          <a href={contact.telHref} onClick={() => track('call_clicked', { location: 'confirmation' })} className={buttonClass('primary', 'lg', 'text-base')}>
            <PhoneIcon size={17} /> Call us
          </a>
        )}
        {contact.whatsappHref && (
          <a
            href={contact.whatsappHref}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => track('whatsapp_clicked', { location: 'confirmation' })}
            className={buttonClass('secondary', 'lg', 'text-base')}
          >
            <WhatsAppIcon /> WhatsApp us
          </a>
        )}
        <Button variant="secondary" size="lg" className="text-base" onClick={f.reset}>
          Book another car
        </Button>
        {onDone && (
          <Button variant="ghost" size="lg" className="text-base" onClick={onDone}>
            Done
          </Button>
        )}
      </div>
    </div>
  );
}
