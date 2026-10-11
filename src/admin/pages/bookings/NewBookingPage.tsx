// /admin/bookings/new: phone, walk-in and WhatsApp bookings (BKA-06), with the same fields and
// checks as the website form (5.4). Staff-created bookings skip the notice period and time step.
// Optional query params (e.g. from the calendar, CAL-02): ?car=<id>&date=YYYY-MM-DD&time=HH:MM or &pickup=<ISO>.
import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ArrowLeft, Clock } from 'lucide-react';
import { computeReturn, extraHourRate, packagePrice } from '@shared/booking.ts';
import { FLAG_LABELS, PACKAGE_LABELS, SOURCE_LABELS, type BookingFlag, type BookingPackage, type BookingSource } from '@shared/constants.ts';
import type { BookingRules, BusinessSettings } from '@shared/settings.ts';
import { WEEKDAY_LABELS } from '@shared/settings.ts';
import { formatClock, fromIst, isHHMM, isIsoDate, weekdayOf } from '@shared/time.ts';
import {
  checkDl,
  MESSAGES,
  normalizeDl,
  normalizeName,
  normalizePhone,
  validateEmail,
  validateName,
  validatePhone,
  validatePickup,
} from '@shared/validation.ts';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Alert, Checkbox, Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Card, CardBody, CardHeader, EmptyState, PageHeader } from '@/components/ui/Layout';
import { PageSpinner } from '@/components/ui/Spinner';
import { api } from '@/integrations/api/client';
import { errorMessage, toAppError, unwrap } from '@/lib/errors';
import { formatRupees, formatWhen, istDateIso, istTime, paiseToInput, parseRupees } from '@/lib/format';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { useNow } from '@/lib/useNow';
import type { Car, Clash, PaperProblem } from '@/types/db';
import { qk, useCars, useSetting } from '../../hooks/queries';
import { AvailabilityWarnings, LookupNote, PillRadios, type CustomerMatch, type Lookup } from './list/NewBookingParts';

type AdminSource = Exclude<BookingSource, 'website'>;
const ADMIN_SOURCES: AdminSource[] = ['phone', 'walk_in', 'whatsapp'];

type FieldKey =
  | 'source'
  | 'car_id'
  | 'package'
  | 'pickup'
  | 'phone'
  | 'full_name'
  | 'dl_number'
  | 'email'
  | 'price'
  | 'price_reason'
  | 'deposit'
  | 'consent';
type Errors = Partial<Record<FieldKey, string>>;

/** Form order, used to focus the first problem. */
const ORDER: FieldKey[] = [
  'source',
  'car_id',
  'package',
  'pickup',
  'phone',
  'full_name',
  'dl_number',
  'email',
  'price',
  'price_reason',
  'deposit',
  'consent',
];

const FIELD_IDS: Record<FieldKey, string> = {
  source: 'nb-source-phone',
  car_id: 'nb-car',
  package: 'nb-hours',
  pickup: 'nb-date',
  phone: 'nb-phone',
  full_name: 'nb-name',
  dl_number: 'nb-dl',
  email: 'nb-email',
  price: 'nb-price',
  price_reason: 'nb-reason',
  deposit: 'nb-deposit',
  consent: 'nb-consent',
};

/** SQL error `details` codes from admin_create_booking → form fields. */
const CODE_TO_FIELD: Record<string, FieldKey> = {
  source: 'source',
  car_id: 'car_id',
  package: 'package',
  pickup: 'pickup',
  phone: 'phone',
  full_name: 'full_name',
  dl_number: 'dl_number',
  email: 'email',
  price: 'price',
  price_reason: 'price_reason',
  consent: 'consent',
};

const CONSENT_TEXT =
  'I agree that KSR Self Drive Cars can use my name, mobile number and driving licence details to process this booking, verify my identity at pickup, and handle any fines or damage linked to this rental.';

interface CreateResult {
  ok: boolean;
  booking_id: string;
  booking_code: string;
  flags: BookingFlag[];
  clashes: Clash[];
}

interface Initial {
  carId: string;
  date: string;
  time: string;
  source: AdminSource;
}

function initialFrom(p: URLSearchParams, cars: Car[]): Initial {
  const car = p.get('car') ?? '';
  let date = p.get('date') ?? '';
  let time = p.get('time') ?? '';
  const pickup = p.get('pickup');
  if (pickup && !Number.isNaN(Date.parse(pickup))) {
    date = istDateIso(pickup);
    time = istTime(pickup);
  }
  const source = p.get('source') as AdminSource | null;
  return {
    carId: cars.some((c) => c.id === car) ? car : '',
    date: isIsoDate(date) ? date : '',
    time: isHHMM(time) ? time : '',
    source: source && ADMIN_SOURCES.includes(source) ? source : 'phone',
  };
}

export default function NewBookingPage() {
  useDocumentMeta({ title: 'New booking · KSR admin', noindex: true });
  const [params] = useSearchParams();
  const cars = useCars();
  const business = useSetting('business');
  const rules = useSetting('booking_rules');

  const header = (
    <PageHeader
      title="New booking"
      description="For phone, walk-in and WhatsApp customers."
      back={
        <Link to="/admin/bookings" className="inline-flex min-h-11 w-fit items-center gap-1.5 font-semibold">
          <ArrowLeft size={18} aria-hidden="true" /> Bookings
        </Link>
      }
    />
  );

  if (cars.isPending || business.isPending || rules.isPending) {
    return (
      <>
        {header}
        <PageSpinner label="Loading cars and settings" />
      </>
    );
  }
  const failed = cars.error ?? business.error ?? rules.error;
  if (failed || !cars.data || !business.data || !rules.data) {
    return (
      <>
        {header}
        <Alert title="Couldn't load the form">{errorMessage(failed)}</Alert>
      </>
    );
  }
  const activeCars = cars.data.filter((c) => c.status === 'active');
  if (!activeCars.length) {
    return (
      <>
        {header}
        <EmptyState title="No active cars" action={<ButtonLink to="/admin/fleet">Go to fleet</ButtonLink>}>
          Make a car active before creating a booking.
        </EmptyState>
      </>
    );
  }
  return (
    <>
      {header}
      <NewBookingForm cars={activeCars} business={business.data} rules={rules.data} initial={initialFrom(params, activeCars)} />
    </>
  );
}

function NewBookingForm({
  cars,
  business,
  rules,
  initial,
}: {
  cars: Car[];
  business: BusinessSettings;
  rules: BookingRules;
  initial: Initial;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const now = useNow();
  const todayIso = istDateIso(now);

  const [source, setSource] = useState<AdminSource>(initial.source);
  const [carId, setCarId] = useState(initial.carId);
  const [pkg, setPkg] = useState<BookingPackage>('12h');
  const [hoursText, setHoursText] = useState('');
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [dl, setDl] = useState('');
  const [email, setEmail] = useState('');
  /** null = use the standard package price. */
  const [priceText, setPriceText] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  /** null = use the default deposit from Settings. */
  const [depositText, setDepositText] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [consent, setConsent] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** A submit was attempted, so the "fix the fields" note can show. */
  const [tried, setTried] = useState(false);
  const [lookup, setLookup] = useState<Lookup>({ state: 'idle' });
  const phoneRef = useRef('');

  // ---------------------------------------------------------------- derived values
  const car = cars.find((c) => c.id === carId) ?? null;
  const customHours = pkg === 'custom' ? Number(hoursText) : null;
  const hoursOk = pkg !== 'custom' || (Number.isInteger(customHours) && customHours! >= 1 && customHours! <= 720);
  const pickupAt = fromIst(date, time);
  const returnAt = pickupAt && hoursOk ? computeReturn(pickupAt, pkg, customHours) : null;
  const startIso = pickupAt?.toISOString() ?? null;
  const endIso = returnAt?.toISOString() ?? null;

  const standardPrice = car && pkg !== 'custom' ? packagePrice(car, pkg) : null;
  const priceInput = priceText ?? (standardPrice !== null ? paiseToInput(standardPrice) : '');
  const pricePaise = priceInput.trim() ? parseRupees(priceInput) : null;
  const priceChanged = pkg !== 'custom' && priceText !== null && pricePaise !== standardPrice;
  const suggestedCustom = car && pkg === 'custom' && hoursOk && customHours ? customHours * extraHourRate(car, rules) : null;

  const depositInput = depositText ?? paiseToInput(rules.default_deposit_paise);
  const depositPaise = depositInput.trim() ? parseRupees(depositInput) : 0;

  const dayHours = isIsoDate(date) ? business.hours[weekdayOf(date)] : null;
  const timeStep = source === 'walk_in' ? 60 : Math.max(5, rules.time_step_minutes || 30) * 60;

  const clashes = useQuery({
    queryKey: [...qk.bookings, 'clashes', carId, startIso, endIso],
    enabled: Boolean(carId && startIso && endIso),
    queryFn: async () =>
      unwrap(await api.rpc('car_clashes', { p_car: carId, p_start: startIso, p_end: endIso, p_exclude: null })) as Clash[],
  });
  const papers = useQuery({
    queryKey: [...qk.documents, 'paper-problems', carId, endIso],
    enabled: Boolean(carId),
    queryFn: async () =>
      unwrap(await api.rpc('car_paper_problems', endIso ? { p_car: carId, p_until: endIso } : { p_car: carId })) as PaperProblem[],
  });

  // ---------------------------------------------------------------- validation (BK-05: on blur and on submit)
  function check(key: FieldKey): string | null {
    switch (key) {
      case 'source':
        return null;
      case 'car_id':
        return car ? null : MESSAGES.carRequired;
      case 'package':
        return hoursOk ? null : 'Enter the number of hours, from 1 to 720.';
      case 'pickup':
        return validatePickup(date, time, { rules, hours: business.hours, now, skipLeadTime: true });
      case 'phone':
        return validatePhone(phone);
      case 'full_name':
        return validateName(name);
      case 'dl_number':
        return checkDl(dl).error;
      case 'email':
        return validateEmail(email);
      case 'price':
        if (pricePaise !== null) return null;
        return pkg === 'custom' ? 'Enter a price for a custom package.' : 'Enter the price in rupees, for example 1800.';
      case 'price_reason':
        return priceChanged && !reason.trim() ? 'Give a reason for changing the price.' : null;
      case 'deposit':
        return depositPaise === null ? 'Enter the deposit in rupees, or 0 for none.' : null;
      case 'consent':
        return consent ? null : 'Tick the box once the customer has agreed to how we use their details.';
    }
  }

  const setFieldError = (key: FieldKey, message: string | null) =>
    setErrors((prev) => {
      if ((prev[key] ?? null) === message) return prev;
      const next = { ...prev };
      if (message) next[key] = message;
      else delete next[key];
      return next;
    });
  const touch = (key: FieldKey) => setFieldError(key, check(key));
  const clear = (key: FieldKey) => setFieldError(key, null);

  const focusField = (key: FieldKey) => {
    const el = document.getElementById(FIELD_IDS[key]) ?? (key === 'package' ? document.getElementById('nb-pkg-12h') : null);
    el?.focus();
  };

  // ---------------------------------------------------------------- customer lookup (CUS-01)
  async function lookUpPhone() {
    touch('phone');
    const e164 = normalizePhone(phone);
    if (!e164 || (lookup.state !== 'idle' && lookup.phone === e164)) return;
    setLookup({ state: 'loading', phone: e164 });
    try {
      const row = unwrap(
        await api
          .from('customers')
          .select('id, full_name, email, dl_number, dl_expiry, blocked, block_reason, identity_verified')
          .eq('phone', e164)
          .maybeSingle(),
      ) as CustomerMatch | null;
      if (normalizePhone(phoneRef.current) !== e164) return; // the number changed while we looked
      if (!row) {
        setLookup({ state: 'new', phone: e164 });
        return;
      }
      setName((v) => (v.trim() ? v : row.full_name));
      setEmail((v) => (v.trim() ? v : (row.email ?? '')));
      setDl((v) => (v.trim() ? v : (row.dl_number ?? '')));
      setErrors((prev) => {
        const next = { ...prev };
        delete next.full_name;
        delete next.email;
        delete next.dl_number;
        return next;
      });
      setLookup({ state: 'found', phone: e164, customer: row });
    } catch {
      // Looking up is a convenience; the server still matches the customer by mobile number.
      setLookup({ state: 'idle' });
    }
  }

  // ---------------------------------------------------------------- submit
  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setTried(true);
    const next: Errors = {};
    for (const key of ORDER) {
      const message = check(key);
      if (message) next[key] = message;
    }
    setErrors(next);
    const first = ORDER.find((k) => next[k]);
    if (first) {
      focusField(first);
      return;
    }

    const overridePrice = pkg === 'custom' || pricePaise !== standardPrice ? pricePaise : null;
    setBusy(true);
    try {
      const res = unwrap(
        await api.rpc('admin_create_booking', {
          p_car_id: carId,
          p_package: pkg,
          p_pickup_at: startIso,
          p_full_name: normalizeName(name),
          p_phone: normalizePhone(phone),
          p_dl_number: normalizeDl(dl),
          p_source: source,
          p_consent_confirmed: consent,
          p_email: email.trim() || null,
          p_custom_hours: pkg === 'custom' ? customHours : null,
          p_price_override_paise: overridePrice,
          p_override_reason: overridePrice !== null && reason.trim() ? reason.trim() : null,
          p_admin_notes: notes.trim(),
          p_deposit_paise: depositPaise,
        }),
      ) as CreateResult;
      void queryClient.invalidateQueries({ queryKey: qk.bookings });
      void queryClient.invalidateQueries({ queryKey: qk.customers });
      const flags = res.flags ?? [];
      toast.success(
        flags.length
          ? `Booking ${res.booking_code} created. Flagged: ${flags.map((f) => FLAG_LABELS[f] ?? f).join(', ')}.`
          : `Booking ${res.booking_code} created.`,
      );
      navigate(`/admin/bookings/${encodeURIComponent(res.booking_code)}`);
    } catch (err) {
      const appErr = toAppError(err);
      const field = appErr.code ? CODE_TO_FIELD[appErr.code] : undefined;
      if (field) {
        setErrors((prev) => ({ ...prev, [field]: appErr.message }));
        focusField(field);
      } else {
        setFormError(appErr.message);
      }
    } finally {
      setBusy(false);
    }
  }

  function pickUpNow() {
    const t = Date.now();
    setDate(istDateIso(t));
    setTime(istTime(t));
    clear('pickup');
  }

  const dlCheck = dl.trim() ? checkDl(dl) : null;
  const returnDateIso = returnAt ? istDateIso(returnAt) : null;
  const flaggedClash = Boolean(clashes.data?.length);

  // ---------------------------------------------------------------- render
  return (
    <form onSubmit={submit} noValidate className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="flex min-w-0 flex-col gap-5">
        <Card>
          <CardHeader title="Booking" />
          <CardBody className="flex flex-col gap-5">
            <PillRadios
              name="nb-source"
              legend="Source"
              value={source}
              error={errors.source}
              onChange={(v) => {
                setSource(v);
                clear('source');
              }}
              options={ADMIN_SOURCES.map((s) => ({ value: s, label: SOURCE_LABELS[s] }))}
            />

            <Field label="Car" required error={errors.car_id}>
              <Select
                id="nb-car"
                value={carId}
                onChange={(e) => {
                  setCarId(e.target.value);
                  setPriceText(null);
                  clear('car_id');
                }}
                onBlur={() => touch('car_id')}
              >
                <option value="">Choose a car</option>
                {cars.map((c) => (
                  <option key={c.id} value={c.id}>
                    {`${c.display_name}${c.registration_number ? ` · ${c.registration_number}` : ''} — ${formatRupees(c.price_12h_paise)} / 12 hrs, ${formatRupees(c.price_24h_paise)} / 24 hrs`}
                  </option>
                ))}
              </Select>
            </Field>

            <div className="flex flex-col gap-3">
              <PillRadios
                name="nb-pkg"
                legend="Package"
                value={pkg}
                onChange={(v) => {
                  setPkg(v);
                  setPriceText(null);
                  clear('package');
                  clear('price');
                  clear('price_reason');
                }}
                options={[
                  { value: '12h', label: PACKAGE_LABELS['12h'], extra: car ? formatRupees(car.price_12h_paise) : undefined },
                  { value: '24h', label: PACKAGE_LABELS['24h'], extra: car ? formatRupees(car.price_24h_paise) : undefined },
                  { value: 'custom', label: 'Custom hours' },
                ]}
              />
              {pkg === 'custom' && (
                <Field label="Hours" required error={errors.package} hint="From 1 to 720 hours." className="max-w-xs">
                  <Input
                    id="nb-hours"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={720}
                    step={1}
                    value={hoursText}
                    onChange={(e) => {
                      setHoursText(e.target.value);
                      clear('package');
                    }}
                    onBlur={() => touch('package')}
                  />
                </Field>
              )}
            </div>

            <fieldset className="m-0 min-w-0 border-0 p-0">
              <legend className="mb-2 p-0 font-semibold">Pickup (IST)</legend>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field
                  label="Date"
                  required
                  error={errors.pickup}
                  hint={
                    dayHours
                      ? dayHours.closed
                        ? `Closed on ${WEEKDAY_LABELS[weekdayOf(date)]}s.`
                        : `Open ${formatClock(dayHours.open)} to ${formatClock(dayHours.close)}.`
                      : `Up to ${rules.window_days} days ahead.`
                  }
                >
                  <Input
                    id="nb-date"
                    type="date"
                    min={todayIso}
                    value={date}
                    onChange={(e) => {
                      setDate(e.target.value);
                      clear('pickup');
                    }}
                    onBlur={() => {
                      if (time) touch('pickup');
                    }}
                  />
                </Field>
                <div className="flex min-w-0 flex-col gap-2">
                  <label htmlFor="nb-time" className="font-semibold">
                    Time
                    <span aria-hidden="true" className="text-danger">
                      {' '}
                      *
                    </span>
                  </label>
                  <Input
                    id="nb-time"
                    type="time"
                    step={timeStep}
                    value={time}
                    invalid={Boolean(errors.pickup)}
                    aria-invalid={errors.pickup ? true : undefined}
                    aria-describedby={['nb-time-hint', errors.pickup ? 'nb-date-error' : ''].filter(Boolean).join(' ')}
                    onChange={(e) => {
                      setTime(e.target.value);
                      clear('pickup');
                    }}
                    onBlur={() => {
                      if (date) touch('pickup');
                    }}
                  />
                  <p id="nb-time-hint" className="m-0 text-sm text-muted">
                    {source === 'walk_in' ? 'Any time within opening hours.' : `Usually on a ${rules.time_step_minutes}-minute step.`}
                  </p>
                </div>
              </div>
              {source === 'walk_in' && (
                <Button variant="secondary" size="sm" className="mt-3" icon={<Clock size={16} aria-hidden="true" />} onClick={pickUpNow}>
                  Pick up now
                </Button>
              )}
              <p className="m-0 mt-3 text-[15px]" aria-live="polite">
                Return by:{' '}
                <strong>{returnAt ? formatWhen(returnAt) : pkg === 'custom' && !hoursOk ? 'enter the hours' : 'choose a pickup date and time'}</strong>
              </p>
            </fieldset>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Customer" description="Enter the mobile number first: we fill in details for customers we already know." />
          <CardBody className="flex flex-col gap-5">
            <Field label="Mobile number" required error={errors.phone} hint="10-digit Indian mobile number.">
              <Input
                id="nb-phone"
                type="tel"
                inputMode="tel"
                autoComplete="off"
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value);
                  phoneRef.current = e.target.value;
                  setLookup({ state: 'idle' });
                  clear('phone');
                }}
                onBlur={() => void lookUpPhone()}
              />
            </Field>
            <LookupNote lookup={lookup} dlTyped={dlCheck?.value ?? ''} returnDateIso={returnDateIso} />
            <Field label="Full name" required error={errors.full_name}>
              <Input
                id="nb-name"
                autoComplete="off"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  clear('full_name');
                }}
                onBlur={() => touch('full_name')}
              />
            </Field>
            <Field
              label="Driving licence number"
              required
              error={errors.dl_number}
              hint={dlCheck && !dlCheck.error && dlCheck.oldFormat ? MESSAGES.dlOldFormat : 'As printed, for example TS0920110012345.'}
            >
              <Input
                id="nb-dl"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                value={dl}
                onChange={(e) => {
                  setDl(e.target.value.toUpperCase());
                  clear('dl_number');
                }}
                onBlur={() => {
                  if (dl.trim()) setDl(normalizeDl(dl));
                  touch('dl_number');
                }}
              />
            </Field>
            <Field label="Email" optional error={errors.email}>
              <Input
                id="nb-email"
                type="email"
                autoComplete="off"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  clear('email');
                }}
                onBlur={() => touch('email')}
              />
            </Field>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Price and deposit" />
          <CardBody className="flex flex-col gap-5">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field
                label="Price (₹)"
                required
                error={errors.price}
                hint={
                  pkg === 'custom'
                    ? suggestedCustom !== null
                      ? `No standard price for custom hours. Suggested: ${formatRupees(suggestedCustom)}.`
                      : 'No standard price for custom hours. Enter the agreed price.'
                    : standardPrice !== null
                      ? priceChanged
                        ? `Changed from the standard ${formatRupees(standardPrice)}.`
                        : 'Standard price for this package.'
                      : 'Choose a car to see its price.'
                }
              >
                <Input
                  id="nb-price"
                  inputMode="decimal"
                  autoComplete="off"
                  value={priceInput}
                  onChange={(e) => {
                    setPriceText(e.target.value);
                    clear('price');
                  }}
                  onBlur={() => touch('price')}
                />
              </Field>
              <Field label="Deposit (₹)" error={errors.deposit} hint={`Default from Settings: ${formatRupees(rules.default_deposit_paise)}.`}>
                <Input
                  id="nb-deposit"
                  inputMode="decimal"
                  autoComplete="off"
                  value={depositInput}
                  onChange={(e) => {
                    setDepositText(e.target.value);
                    clear('deposit');
                  }}
                  onBlur={() => touch('deposit')}
                />
              </Field>
            </div>
            {(priceChanged || (pkg === 'custom' && suggestedCustom !== null)) && (
              <div className="flex flex-wrap gap-2">
                {priceChanged && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setPriceText(null);
                      clear('price');
                      clear('price_reason');
                    }}
                  >
                    Use the standard price
                  </Button>
                )}
                {pkg === 'custom' && suggestedCustom !== null && pricePaise !== suggestedCustom && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setPriceText(paiseToInput(suggestedCustom));
                      clear('price');
                    }}
                  >
                    Use {formatRupees(suggestedCustom)}
                  </Button>
                )}
              </div>
            )}
            {priceChanged && (
              <Field label="Reason for the price change" required error={errors.price_reason} hint="Saved in the booking timeline.">
                <Input
                  id="nb-reason"
                  value={reason}
                  onChange={(e) => {
                    setReason(e.target.value);
                    clear('price_reason');
                  }}
                  onBlur={() => touch('price_reason')}
                />
              </Field>
            )}
            <Field label="Notes for staff" optional hint="Only staff see these.">
              <Textarea id="nb-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
            </Field>
          </CardBody>
        </Card>
      </div>

      <aside className="flex min-w-0 flex-col gap-5 lg:sticky lg:top-6">
        <Card>
          <CardHeader title="Summary" />
          <CardBody>
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[15px]">
              <dt className="text-muted">Car</dt>
              <dd className="m-0 font-semibold">{car ? car.display_name : '—'}</dd>
              <dt className="text-muted">Package</dt>
              <dd className="m-0 font-semibold">{pkg === 'custom' ? (hoursOk ? `${customHours} hrs (custom)` : 'Custom') : PACKAGE_LABELS[pkg]}</dd>
              <dt className="text-muted">Pickup</dt>
              <dd className="m-0 font-semibold">{pickupAt ? formatWhen(pickupAt) : '—'}</dd>
              <dt className="text-muted">Return by</dt>
              <dd className="m-0 font-semibold">{returnAt ? formatWhen(returnAt) : '—'}</dd>
              <dt className="text-muted">Price</dt>
              <dd className="m-0 font-semibold">{pricePaise !== null ? formatRupees(pricePaise) : '—'}</dd>
              <dt className="text-muted">Deposit</dt>
              <dd className="m-0 font-semibold">{depositPaise !== null ? formatRupees(depositPaise) : '—'}</dd>
              <dt className="text-muted">Fuel</dt>
              <dd className="m-0">As per policy: {rules.fuel_policy}</dd>
            </dl>
          </CardBody>
        </Card>

        {car && (
          <AvailabilityWarnings
            carId={car.id}
            ready={Boolean(startIso && endIso)}
            clashes={clashes.data}
            clashesLoading={clashes.isFetching && !clashes.data}
            clashesError={clashes.error}
            papers={papers.data}
            todayIso={todayIso}
          />
        )}

        <Card>
          <CardBody className="flex flex-col gap-4">
            <Checkbox
              id="nb-consent"
              checked={consent}
              onChange={(e) => {
                setConsent(e.target.checked);
                clear('consent');
              }}
              error={errors.consent}
              label={
                <>
                  The customer agreed to how we use their details (privacy notice)
                  <span aria-hidden="true" className="text-danger">
                    {' '}
                    *
                  </span>
                </>
              }
              description={
                <>
                  Read this to them: “{CONSENT_TEXT}”{' '}
                  <a href="/privacy" target="_blank" rel="noreferrer">
                    Privacy notice<span className="sr-only"> (opens in a new tab)</span>
                  </a>
                </>
              }
            />
            {formError && <Alert title="Couldn't create the booking">{formError}</Alert>}
            {tried && Object.keys(errors).length > 0 && !formError && (
              <p className="m-0 text-sm font-semibold text-danger" role="alert">
                Fix the highlighted fields, then try again.
              </p>
            )}
            <Button type="submit" size="lg" loading={busy} loadingText="Creating…">
              {flaggedClash ? 'Create booking with clash' : 'Create booking'}
            </Button>
            <ButtonLink to="/admin/bookings" variant="ghost">
              Cancel
            </ButtonLink>
          </CardBody>
        </Card>
      </aside>
    </form>
  );
}
