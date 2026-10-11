// Business details (SET-01) and grievance contact (DP-04). These feed the public site:
// "Call to book", the footer, opening hours and the privacy notice.
import { useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import { WEEKDAY_LABELS, WEEKDAYS, type BusinessSettings, type DayHours, type OpeningHours, type Weekday } from '@shared/settings.ts';
import { isHHMM, minutesOf } from '@shared/time.ts';
import { MESSAGES, formatPhone, normalizePhone, validateEmail } from '@shared/validation.ts';
import { Button } from '@/components/ui/Button';
import { Alert, Checkbox, Field, Input, Textarea } from '@/components/ui/Field';
import { errorMessage } from '@/lib/errors';
import { useSaveSetting, useSetting } from '../../hooks/queries';
import { FormCard, Loader, SaveBar } from './FormParts';
import { Errors, sameJson, validUrl } from './formUtils';

type FormState = Omit<BusinessSettings, 'hours'> & { hours: OpeningHours };
type Key = keyof Omit<FormState, 'hours'> | `hours.${Weekday}`;

const toForm = (b: BusinessSettings): FormState => ({
  ...b,
  phone: formatPhone(b.phone),
  whatsapp: formatPhone(b.whatsapp),
  grievance_phone: formatPhone(b.grievance_phone),
  hours: { ...b.hours },
});

function optionalPhone(errors: Errors<Key>, key: Key, raw: string): string {
  if (!raw.trim()) return '';
  const e164 = normalizePhone(raw);
  if (!e164) errors.set(key, MESSAGES.phoneInvalid);
  return e164 ?? '';
}

function optionalEmail(errors: Errors<Key>, key: Key, raw: string): string {
  const v = raw.trim();
  if (v) errors.set(key, validateEmail(v));
  return v.toLowerCase();
}

function hoursError(h: DayHours): string | null {
  if (h.closed) return null;
  if (!isHHMM(h.open) || !isHHMM(h.close)) return 'Enter an opening and a closing time.';
  if (minutesOf(h.open) >= minutesOf(h.close)) return 'The closing time must be after the opening time.';
  return null;
}

function build(f: FormState): { value: BusinessSettings; errors: Errors<Key> } {
  const errors = new Errors<Key>();
  const name = f.name.trim().replace(/\s+/g, ' ');
  if (!name) errors.set('name', 'Enter the business name.');
  else if (name.length > 80) errors.set('name', 'Use 80 characters or fewer.');
  const map = f.map_url.trim();
  if (map && !validUrl(map)) errors.set('map_url', 'Paste the full link, starting with https://');
  if (f.address.trim().length > 300) errors.set('address', 'Use 300 characters or fewer.');
  if (f.grievance_name.trim().length > 80) errors.set('grievance_name', 'Use 80 characters or fewer.');
  for (const d of WEEKDAYS) errors.set(`hours.${d}`, hoursError(f.hours[d]));
  const value: BusinessSettings = {
    name,
    phone: optionalPhone(errors, 'phone', f.phone),
    whatsapp: optionalPhone(errors, 'whatsapp', f.whatsapp),
    email: optionalEmail(errors, 'email', f.email),
    address: f.address.trim(),
    map_url: map,
    hours: f.hours,
    grievance_name: f.grievance_name.trim(),
    grievance_email: optionalEmail(errors, 'grievance_email', f.grievance_email),
    grievance_phone: optionalPhone(errors, 'grievance_phone', f.grievance_phone),
  };
  return { value, errors };
}

export function BusinessTab() {
  const query = useSetting('business');
  return <Loader query={query}>{(data) => <BusinessForm key={query.dataUpdatedAt} initial={data} />}</Loader>;
}

function BusinessForm({ initial }: { initial: BusinessSettings }) {
  const save = useSaveSetting('business');
  const [form, setForm] = useState<FormState>(() => toForm(initial));
  const [errors, setErrors] = useState<Partial<Record<Key, string>>>({});
  const dirty = !sameJson(form, toForm(initial));
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setDay = (d: Weekday, patch: Partial<DayHours>) => setForm((f) => ({ ...f, hours: { ...f.hours, [d]: { ...f.hours[d], ...patch } } }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const { value, errors: errs } = build(form);
    setErrors(errs.map);
    if (!errs.ok) {
      toast.error('Some details need fixing. Check the highlighted fields.');
      return;
    }
    try {
      await save.mutateAsync(value);
      toast.success('Business details saved. The website shows them straight away.');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const text = (k: Exclude<Key, `hours.${Weekday}`>) => ({
    value: form[k],
    onChange: (e: { target: { value: string } }) => set(k, e.target.value),
  });

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      <FormCard title="Business details" description="Shown on the website header, footer and booking confirmation.">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Business name" required error={errors.name}>
            <Input {...text('name')} maxLength={80} />
          </Field>
          <Field label="Phone number" error={errors.phone} hint="Used for every “Call to book” button on the website.">
            <Input type="tel" inputMode="tel" {...text('phone')} placeholder="98765 43210" />
          </Field>
          <Field label="WhatsApp number" optional error={errors.whatsapp} hint="Shows a WhatsApp button on the website when set.">
            <Input type="tel" inputMode="tel" {...text('whatsapp')} />
          </Field>
          <Field label="Email" optional error={errors.email}>
            <Input type="email" {...text('email')} />
          </Field>
          <Field label="Pickup address" optional error={errors.address} className="md:col-span-2">
            <Textarea rows={2} {...text('address')} maxLength={300} />
          </Field>
          <Field label="Map link" optional error={errors.map_url} hint="A Google Maps share link to the pickup point." className="md:col-span-2">
            <Input type="url" inputMode="url" {...text('map_url')} placeholder="https://maps.app.goo.gl/…" />
          </Field>
        </div>
        {!form.phone.trim() && (
          <Alert tone="warning">Without a phone number the website can't show “Call to book”. Add one before launch.</Alert>
        )}
      </FormCard>

      <FormCard title="Opening hours" description="Pickups can be booked between these times (IST). The closing time is the last pickup time.">
        <div className="flex flex-col gap-3">
          {WEEKDAYS.map((d) => {
            const h = form.hours[d];
            const err = errors[`hours.${d}`];
            return (
              <fieldset key={d} className="m-0 flex flex-wrap items-end gap-3 rounded-xl border border-line-card p-3">
                <legend className="px-1 font-semibold">{WEEKDAY_LABELS[d]}</legend>
                <Checkbox label="Closed" checked={h.closed} onChange={(e) => setDay(d, { closed: e.target.checked })} className="w-28" />
                {!h.closed && (
                  <>
                    <Field label="Opens" className="w-36">
                      <Input type="time" value={h.open} onChange={(e) => setDay(d, { open: e.target.value })} invalid={Boolean(err)} />
                    </Field>
                    <Field label="Closes" className="w-36">
                      <Input type="time" value={h.close} onChange={(e) => setDay(d, { close: e.target.value })} invalid={Boolean(err)} />
                    </Field>
                  </>
                )}
                {err && (
                  <p role="alert" className="m-0 w-full text-sm font-semibold text-danger">
                    {err}
                  </p>
                )}
              </fieldset>
            );
          })}
        </div>
        <div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setForm((f) => ({ ...f, hours: Object.fromEntries(WEEKDAYS.map((d) => [d, { ...f.hours.mon }])) as OpeningHours }))}
          >
            Use Monday's hours for every day
          </Button>
        </div>
      </FormCard>

      <FormCard
        title="Grievance officer"
        description="Shown on the privacy notice so customers know who to contact about their data (DPDP Act)."
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Name" error={errors.grievance_name}>
            <Input {...text('grievance_name')} maxLength={80} />
          </Field>
          <Field label="Email" error={errors.grievance_email}>
            <Input type="email" {...text('grievance_email')} />
          </Field>
          <Field label="Phone" optional error={errors.grievance_phone}>
            <Input type="tel" inputMode="tel" {...text('grievance_phone')} />
          </Field>
        </div>
        {(!form.grievance_name.trim() || !form.grievance_email.trim()) && (
          <Alert tone="warning">The privacy notice needs a grievance contact. Add at least a name and an email.</Alert>
        )}
      </FormCard>

      <SaveBar dirty={dirty} saving={save.isPending} hasErrors={Object.keys(errors).length > 0 && dirty} />
    </form>
  );
}
