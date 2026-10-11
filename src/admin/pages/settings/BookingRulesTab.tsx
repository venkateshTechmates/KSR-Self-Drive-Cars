// Booking rules (SET-02): lead time, window, time step, buffers, late fees, deposit, km limits
// and fuel policy. The website and the database read these, so changes apply to new bookings.
import { useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import { paiseToInput } from '@shared/money.ts';
import type { BookingRules } from '@shared/settings.ts';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { errorMessage } from '@/lib/errors';
import { useSaveSetting, useSetting } from '../../hooks/queries';
import { FormCard, Loader, SaveBar } from './FormParts';
import { Errors, parseMoney, parseOptionalMoney, parseOptionalWhole, parseWhole, sameJson } from './formUtils';

type FormState = Record<keyof BookingRules, string>;

const STEPS = [15, 30, 60];

const toForm = (r: BookingRules): FormState => ({
  min_lead_hours: String(r.min_lead_hours),
  window_days: String(r.window_days),
  time_step_minutes: String(r.time_step_minutes),
  turnaround_buffer_minutes: String(r.turnaround_buffer_minutes),
  late_grace_minutes: String(r.late_grace_minutes),
  late_fee_per_hour_paise: paiseToInput(r.late_fee_per_hour_paise),
  extra_hour_rate_paise: paiseToInput(r.extra_hour_rate_paise),
  default_deposit_paise: paiseToInput(r.default_deposit_paise),
  km_limit_12h: r.km_limit_12h === null ? '' : String(r.km_limit_12h),
  km_limit_24h: r.km_limit_24h === null ? '' : String(r.km_limit_24h),
  extra_km_rate_paise: paiseToInput(r.extra_km_rate_paise),
  fuel_policy: r.fuel_policy,
  no_show_grace_minutes: String(r.no_show_grace_minutes),
});

function build(f: FormState): { value: BookingRules; errors: Errors<keyof BookingRules> } {
  const e = new Errors<keyof BookingRules>();
  const fuel = f.fuel_policy.trim();
  if (!fuel) e.set('fuel_policy', 'Describe the fuel policy, for example “Return with the same fuel level as at pickup.”');
  else if (fuel.length > 500) e.set('fuel_policy', 'Use 500 characters or fewer.');
  const value: BookingRules = {
    min_lead_hours: e.take('min_lead_hours', parseWhole(f.min_lead_hours, 0, 168)),
    window_days: e.take('window_days', parseWhole(f.window_days, 1, 365)),
    time_step_minutes: e.take('time_step_minutes', parseWhole(f.time_step_minutes, 5, 120)),
    turnaround_buffer_minutes: e.take('turnaround_buffer_minutes', parseWhole(f.turnaround_buffer_minutes, 0, 720)),
    late_grace_minutes: e.take('late_grace_minutes', parseWhole(f.late_grace_minutes, 0, 240)),
    late_fee_per_hour_paise: e.take('late_fee_per_hour_paise', parseMoney(f.late_fee_per_hour_paise)),
    extra_hour_rate_paise: e.take('extra_hour_rate_paise', parseMoney(f.extra_hour_rate_paise)),
    default_deposit_paise: e.take('default_deposit_paise', parseMoney(f.default_deposit_paise)),
    km_limit_12h: e.take('km_limit_12h', parseOptionalWhole(f.km_limit_12h, 1, 5000)),
    km_limit_24h: e.take('km_limit_24h', parseOptionalWhole(f.km_limit_24h, 1, 5000)),
    extra_km_rate_paise: e.take('extra_km_rate_paise', parseOptionalMoney(f.extra_km_rate_paise)),
    fuel_policy: fuel,
    no_show_grace_minutes: e.take('no_show_grace_minutes', parseWhole(f.no_show_grace_minutes, 0, 1440)),
  };
  if ((value.km_limit_12h !== null || value.km_limit_24h !== null) && value.extra_km_rate_paise === null) {
    e.set('extra_km_rate_paise', 'Set a rate for extra kilometres, or clear the km limits.');
  }
  return { value, errors: e };
}

export function BookingRulesTab() {
  const query = useSetting('booking_rules');
  return <Loader query={query}>{(data) => <RulesForm key={query.dataUpdatedAt} initial={data} />}</Loader>;
}

function RulesForm({ initial }: { initial: BookingRules }) {
  const save = useSaveSetting('booking_rules');
  const [form, setForm] = useState<FormState>(() => toForm(initial));
  const [errors, setErrors] = useState<Partial<Record<keyof BookingRules, string>>>({});
  const dirty = !sameJson(form, toForm(initial));

  const bind = (k: keyof BookingRules, numeric: 'numeric' | 'decimal' = 'numeric') => ({
    value: form[k],
    onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value })),
    inputMode: numeric,
    invalid: Boolean(errors[k]),
  });

  async function submit(e: FormEvent) {
    e.preventDefault();
    const { value, errors: errs } = build(form);
    setErrors(errs.map);
    if (!errs.ok) {
      toast.error('Some rules need fixing. Check the highlighted fields.');
      return;
    }
    try {
      await save.mutateAsync(value);
      toast.success('Booking rules saved. They apply to new bookings.');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const steps = STEPS.includes(Number(form.time_step_minutes)) ? STEPS : [...STEPS, Number(form.time_step_minutes)].sort((a, b) => a - b);

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      <FormCard title="When customers can book" description="The website's date and time pickers follow these rules.">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Minimum notice (hours)" error={errors.min_lead_hours} hint="How soon after booking the pickup can be.">
            <Input {...bind('min_lead_hours')} />
          </Field>
          <Field label="Booking window (days)" error={errors.window_days} hint="How far ahead customers can book.">
            <Input {...bind('window_days')} />
          </Field>
          <Field label="Pickup time step" error={errors.time_step_minutes} hint="Times offered in the picker.">
            <Select value={form.time_step_minutes} onChange={(e) => setForm((f) => ({ ...f, time_step_minutes: e.target.value }))}>
              {steps.map((s) => (
                <option key={s} value={String(s)}>
                  Every {s} minutes
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </FormCard>

      <FormCard title="Between bookings and returns">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Turnaround buffer (minutes)" error={errors.turnaround_buffer_minutes} hint="Kept free after each return for cleaning and checks.">
            <Input {...bind('turnaround_buffer_minutes')} />
          </Field>
          <Field label="Late-return grace (minutes)" error={errors.late_grace_minutes} hint="No late fee within this time.">
            <Input {...bind('late_grace_minutes')} />
          </Field>
          <Field label="Late fee per hour (₹)" error={errors.late_fee_per_hour_paise} hint="Suggested at return; staff can adjust.">
            <Input {...bind('late_fee_per_hour_paise', 'decimal')} />
          </Field>
          <Field label="Extension rate per hour (₹)" error={errors.extra_hour_rate_paise} hint="0 works it out from each car's 24 hr price.">
            <Input {...bind('extra_hour_rate_paise', 'decimal')} />
          </Field>
          <Field label="No-show grace (minutes)" error={errors.no_show_grace_minutes} hint="After this, a booking can be marked as a no-show.">
            <Input {...bind('no_show_grace_minutes')} />
          </Field>
          <Field label="Default security deposit (₹)" error={errors.default_deposit_paise} hint="Pre-filled on new bookings. 0 for none.">
            <Input {...bind('default_deposit_paise', 'decimal')} />
          </Field>
        </div>
      </FormCard>

      <FormCard title="Kilometres and fuel" description="Leave the km limits blank if there is no limit.">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Km limit, 12 hr package" optional error={errors.km_limit_12h}>
            <Input {...bind('km_limit_12h')} />
          </Field>
          <Field label="Km limit, 24 hr package" optional error={errors.km_limit_24h}>
            <Input {...bind('km_limit_24h')} />
          </Field>
          <Field label="Extra km rate (₹ per km)" optional error={errors.extra_km_rate_paise}>
            <Input {...bind('extra_km_rate_paise', 'decimal')} />
          </Field>
          <Field label="Fuel policy" required error={errors.fuel_policy} hint="Shown in the booking summary and policies as {fuel_policy}." className="md:col-span-3">
            <Textarea rows={3} value={form.fuel_policy} onChange={(e) => setForm((f) => ({ ...f, fuel_policy: e.target.value }))} maxLength={500} />
          </Field>
        </div>
      </FormCard>

      <SaveBar dirty={dirty} saving={save.isPending} hasErrors={Object.keys(errors).length > 0 && dirty} />
    </form>
  );
}
