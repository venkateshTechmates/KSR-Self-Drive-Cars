// Date range control: presets first, custom dates behind "Custom dates" (IST calendar days).
import { Field, Input, Select } from '@/components/ui/Field';
import { PRESET_LABELS, presetDates, resolveRange, type RangePreset, type RangeState } from './range';

const PRESETS: RangePreset[] = ['this_month', 'last_month', 'last_7', 'last_30', 'last_90'];

export function DateRangeFilter({
  value,
  onChange,
  today,
  allowAll,
  label = 'Dates',
}: {
  value: RangeState;
  onChange: (next: RangeState) => void;
  /** Today's IST date, "YYYY-MM-DD". */
  today: string;
  allowAll?: boolean;
  label?: string;
}) {
  const presets: RangePreset[] = allowAll ? ['all', ...PRESETS, 'custom'] : [...PRESETS, 'custom'];
  const { error } = resolveRange(value, today);

  function choose(preset: RangePreset) {
    if (preset === 'custom') {
      // Start the custom range from what was showing, so the dates are never blank.
      const current = presetDates(value.preset, today) ?? { from: today, to: today };
      onChange({ preset, from: value.from || current.from, to: value.to || current.to });
    } else {
      onChange({ ...value, preset });
    }
  }

  return (
    <>
      <Field label={label} className="w-full sm:w-48">
        <Select value={value.preset} onChange={(e) => choose(e.target.value as RangePreset)}>
          {presets.map((p) => (
            <option key={p} value={p}>
              {PRESET_LABELS[p]}
            </option>
          ))}
        </Select>
      </Field>
      {value.preset === 'custom' && (
        <>
          <Field label="From" className="w-[calc(50%-0.375rem)] sm:w-44">
            <Input type="date" value={value.from} max={value.to || undefined} onChange={(e) => onChange({ ...value, from: e.target.value })} />
          </Field>
          <Field label="To" className="w-[calc(50%-0.375rem)] sm:w-44" error={error}>
            <Input type="date" value={value.to} min={value.from || undefined} onChange={(e) => onChange({ ...value, to: e.target.value })} />
          </Field>
        </>
      )}
    </>
  );
}
