// Small building blocks shared by the booking detail forms.
import { useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { FUEL_LEVEL_LABELS, FUEL_LEVELS, type FuelLevel } from '@shared/constants.ts';
import { Input } from '@/components/ui/Field';
import { cn } from '@/lib/cn';
import { FUEL_SPOKEN } from './helpers';

/** Rupee amount input with a ₹ prefix. Works inside <Field> (id and aria props pass through). */
export function MoneyInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="relative">
      <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-muted">
        ₹
      </span>
      <Input inputMode="decimal" autoComplete="off" {...props} className="pl-8" />
    </div>
  );
}

export interface ChoiceOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Accessible text when the label is a symbol. */
  srLabel?: string;
  disabled?: boolean;
}

/** Radio group drawn as pill buttons (44 px targets, visible focus). */
export function ChoiceChips<T extends string>({
  legend,
  options,
  value,
  onChange,
  error,
  hint,
  required,
  className,
}: {
  legend: ReactNode;
  options: ChoiceOption<T>[];
  value: T | '';
  onChange: (v: T) => void;
  error?: string | null;
  hint?: ReactNode;
  required?: boolean;
  className?: string;
}) {
  const name = useId();
  const errorId = `${name}-error`;
  const hintId = `${name}-hint`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  return (
    <fieldset className={cn('m-0 min-w-0 border-0 p-0', className)} aria-describedby={describedBy}>
      <legend className="mb-2 p-0 font-semibold">
        {legend}
        {required && (
          <span aria-hidden="true" className="text-danger">
            {' '}
            *
          </span>
        )}
      </legend>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <label
            key={o.value}
            className={cn(
              'relative inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-full border px-4 font-semibold select-none',
              'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink',
              value === o.value ? 'border-ink bg-ink text-white' : 'border-line-input bg-white text-ink hover:border-ink',
              o.disabled && 'cursor-not-allowed opacity-50',
              error && value !== o.value && 'border-danger',
            )}
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              disabled={o.disabled}
              onChange={() => onChange(o.value)}
              className="sr-only"
              aria-invalid={error ? true : undefined}
            />
            {o.srLabel ? (
              <>
                <span aria-hidden="true">{o.label}</span>
                <span className="sr-only">{o.srLabel}</span>
              </>
            ) : (
              o.label
            )}
          </label>
        ))}
      </div>
      {hint && (
        <p id={hintId} className="m-0 mt-2 text-sm text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="m-0 mt-2 text-sm font-semibold text-danger">
          {error}
        </p>
      )}
    </fieldset>
  );
}

const FUEL_OPTIONS: ChoiceOption<FuelLevel>[] = FUEL_LEVELS.map((f) => ({
  value: f,
  label: FUEL_LEVEL_LABELS[f],
  srLabel: f === 'empty' || f === 'full' ? undefined : FUEL_SPOKEN[f],
}));

export function FuelPicker({
  value,
  onChange,
  error,
  hint,
}: {
  value: FuelLevel | '';
  onChange: (v: FuelLevel) => void;
  error?: string | null;
  hint?: ReactNode;
}) {
  return <ChoiceChips legend="Fuel level" options={FUEL_OPTIONS} value={value} onChange={onChange} error={error} hint={hint} required />;
}

/** Numbered section heading inside the handover and return forms. */
export function StepHeading({ n, children, id }: { n?: number; children: ReactNode; id?: string }) {
  return (
    <h3 id={id} className="m-0 flex items-center gap-2 text-[17px] font-bold">
      {n !== undefined && (
        <span aria-hidden="true" className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-ink text-sm text-white">
          {n}
        </span>
      )}
      {children}
    </h3>
  );
}

/** Label + big value tile. */
export function Stat({ label, value, tone, note }: { label: ReactNode; value: ReactNode; tone?: 'danger' | 'success'; note?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-line-card bg-subtle px-3 py-2.5">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className={cn('m-0 text-lg font-bold', tone === 'danger' && 'text-danger', tone === 'success' && 'text-emerald-800')}>{value}</dd>
      {note && <dd className="m-0 text-sm text-muted">{note}</dd>}
    </div>
  );
}
