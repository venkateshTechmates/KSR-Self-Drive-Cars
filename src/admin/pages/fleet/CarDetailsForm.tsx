// Details tab: add or edit a car (FLT-02), Active / Inactive (FLT-04), Owner-only delete.
import { useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Save, Trash2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  BADGE_PRESETS,
  BODY_TYPE_LABELS,
  BODY_TYPES,
  CAR_CATEGORIES,
  CATEGORY_LABELS,
  FUEL_LABELS,
  FUEL_TYPES,
  TRANSMISSION_LABELS,
  TRANSMISSIONS,
  type BodyType,
  type CarCategory,
  type CarStatus,
  type FuelType,
  type Transmission,
} from '@shared/constants.ts';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { Alert, Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Card, CardBody, CardHeader } from '@/components/ui/Layout';
import { Spinner } from '@/components/ui/Spinner';
import { api } from '@/integrations/api/client';
import { cn } from '@/lib/cn';
import { AppError, errorMessage, unwrap } from '@/lib/errors';
import { istDateIso } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import type { Car, CarPhoto } from '@/types/db';
import { useRole } from '../../auth/AuthProvider';
import { qk } from '../../hooks/queries';
import {
  carPayload,
  initialCarForm,
  MAX_BADGE,
  MAX_DESCRIPTION,
  updateCarForm,
  validateCarForm,
  type BadgeChoice,
  type CarFormErrors,
  type CarFormField,
  type CarFormState,
} from './carForm';
import { photoFilePaths, useCarLinks } from './fleetData';

const FIELD_ORDER: CarFormField[] = [
  'display_name',
  'slug',
  'seats',
  'year',
  'registration_number',
  'badgeCustom',
  'description',
  'sort_order',
  'price12',
  'price24',
];

const fid = (field: CarFormField) => `car-${field}`;

export function CarDetailsForm({ car, nextSortOrder = 0, onSaved }: { car: Car | null; nextSortOrder?: number; onSaved?: (car: Car) => void }) {
  const queryClient = useQueryClient();
  const role = useRole();
  const now = useNow();
  const isNew = !car;
  const [form, setForm] = useState<CarFormState>(() => initialCarForm(car, nextSortOrder));
  const [touched, setTouched] = useState<Partial<Record<CarFormField, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<CarFormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const currentYear = Number(istDateIso(now).slice(0, 4));
  const errors = validateCarForm(form, { isNew, currentYear });
  const errorFor = (f: CarFormField) => serverErrors[f] ?? (submitted || touched[f] ? errors[f] : undefined);

  function set<K extends CarFormField>(field: K, value: CarFormState[K]) {
    setForm((f) => updateCarForm(f, field, value));
    if (serverErrors[field]) setServerErrors((s) => ({ ...s, [field]: undefined }));
  }
  const blur = (field: CarFormField) => () => setTouched((t) => (t[field] ? t : { ...t, [field]: true }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    setFormError(null);
    const firstInvalid = FIELD_ORDER.find((f) => errors[f]);
    if (firstInvalid) {
      document.getElementById(fid(firstInvalid))?.focus();
      return;
    }
    setSaving(true);
    try {
      // Friendly uniqueness checks; the database enforces both as well.
      const reg = form.registration_number;
      const filters = [`slug.eq.${form.slug}`, ...(reg ? [`registration_number.eq.${reg}`] : [])];
      let q = api.from('cars').select('id, slug, registration_number').or(filters.join(','));
      if (car) q = q.neq('id', car.id);
      const taken = unwrap(await q) as Array<Pick<Car, 'id' | 'slug' | 'registration_number'>>;
      const clash: CarFormErrors = {};
      if (taken.some((t) => t.slug === form.slug)) clash.slug = 'Another car already uses this web name. Change it, for example add the year.';
      if (reg && taken.some((t) => t.registration_number === reg)) clash.registration_number = 'Another car already has this registration number. Check it.';
      if (Object.keys(clash).length) {
        setServerErrors(clash);
        document.getElementById(fid(clash.slug ? 'slug' : 'registration_number'))?.focus();
        return;
      }
      const payload = carPayload(form, isNew);
      const saved = (
        car
          ? unwrap(await api.from('cars').update(payload).eq('id', car.id).select('*').single())
          : unwrap(await api.from('cars').insert(payload).select('*').single())
      ) as Car;
      await queryClient.invalidateQueries({ queryKey: qk.cars });
      toast.success(car ? 'Car saved' : 'Car added');
      onSaved?.(saved);
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <form onSubmit={submit} noValidate className="flex flex-col gap-5">
        <Card>
          <CardHeader title="Name" description="How the car appears on the website." />
          <CardBody className="grid gap-5 sm:grid-cols-2">
            <Field label="Display name" required error={errorFor('display_name')} className="sm:col-span-2">
              <Input
                id={fid('display_name')}
                value={form.display_name}
                onChange={(e) => set('display_name', e.target.value)}
                onBlur={blur('display_name')}
                maxLength={80}
                autoComplete="off"
              />
            </Field>
            <Field
              label="Web name (slug)"
              required
              error={errorFor('slug')}
              hint={isNew ? 'Made from the name. Lowercase letters, numbers and hyphens.' : 'Changing it changes the car’s web address.'}
              className="sm:col-span-2"
            >
              <Input
                id={fid('slug')}
                value={form.slug}
                onChange={(e) => set('slug', e.target.value.toLowerCase().replace(/\s+/g, '-'))}
                onBlur={blur('slug')}
                maxLength={60}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
              />
            </Field>
            <Field label="Brand" optional>
              <Input value={form.brand} onChange={(e) => set('brand', e.target.value)} placeholder="Kia" autoComplete="off" />
            </Field>
            <Field label="Model" optional>
              <Input value={form.model} onChange={(e) => set('model', e.target.value)} placeholder="Sonet" autoComplete="off" />
            </Field>
            <Field label="Variant" optional>
              <Input value={form.variant} onChange={(e) => set('variant', e.target.value)} placeholder="HTK+ 1.2" autoComplete="off" />
            </Field>
            <Field label="Colour" optional>
              <Input value={form.colour} onChange={(e) => set('colour', e.target.value)} autoComplete="off" />
            </Field>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Type and specs" />
          <CardBody className="grid gap-5 sm:grid-cols-2">
            <Field label="Body type" required hint="Sets the category below.">
              <Select value={form.body_type} onChange={(e) => set('body_type', e.target.value as BodyType)}>
                {BODY_TYPES.map((b) => (
                  <option key={b} value={b}>
                    {BODY_TYPE_LABELS[b]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Category" required hint="Used for the website filters.">
              <Select value={form.category} onChange={(e) => set('category', e.target.value as CarCategory)}>
                {CAR_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABELS[c]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Seats" required error={errorFor('seats')}>
              <Input
                id={fid('seats')}
                type="number"
                inputMode="numeric"
                min={2}
                max={12}
                value={form.seats}
                onChange={(e) => set('seats', e.target.value)}
                onBlur={blur('seats')}
              />
            </Field>
            <Field label="Year" optional error={errorFor('year')}>
              <Input
                id={fid('year')}
                type="number"
                inputMode="numeric"
                min={1990}
                max={currentYear + 1}
                value={form.year}
                onChange={(e) => set('year', e.target.value)}
                onBlur={blur('year')}
              />
            </Field>
            <Field label="Fuel" required>
              <Select value={form.fuel} onChange={(e) => set('fuel', e.target.value as FuelType)}>
                {FUEL_TYPES.map((f) => (
                  <option key={f} value={f}>
                    {FUEL_LABELS[f]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Transmission" required>
              <Select value={form.transmission} onChange={(e) => set('transmission', e.target.value as Transmission)}>
                {TRANSMISSIONS.map((t) => (
                  <option key={t} value={t}>
                    {TRANSMISSION_LABELS[t]}
                  </option>
                ))}
              </Select>
            </Field>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Listing" />
          <CardBody className="grid gap-5 sm:grid-cols-2">
            <Field
              label="Registration number"
              optional
              error={errorFor('registration_number')}
              hint="Admin only, never shown on the website. Capitals and numbers, no spaces."
            >
              <Input
                id={fid('registration_number')}
                value={form.registration_number}
                onChange={(e) => set('registration_number', e.target.value)}
                onBlur={blur('registration_number')}
                placeholder="TS09EA1234"
                maxLength={16}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                className="font-mono uppercase"
              />
            </Field>
            <Field label="Display order" required error={errorFor('sort_order')} hint="Lower numbers show first. You can also reorder on the Fleet list.">
              <Input
                id={fid('sort_order')}
                type="number"
                inputMode="numeric"
                min={0}
                value={form.sort_order}
                onChange={(e) => set('sort_order', e.target.value)}
                onBlur={blur('sort_order')}
              />
            </Field>
            <Field label="Badge" optional hint="A short label on the car card.">
              <Select value={form.badgeChoice} onChange={(e) => set('badgeChoice', e.target.value as BadgeChoice)}>
                <option value="none">No badge</option>
                {BADGE_PRESETS.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
                <option value="custom">Custom text…</option>
              </Select>
            </Field>
            {form.badgeChoice === 'custom' ? (
              <Field label="Badge text" required error={errorFor('badgeCustom')} hint={`${form.badgeCustom.trim().length} of ${MAX_BADGE} characters`}>
                <Input
                  id={fid('badgeCustom')}
                  value={form.badgeCustom}
                  onChange={(e) => set('badgeCustom', e.target.value)}
                  onBlur={blur('badgeCustom')}
                  maxLength={MAX_BADGE + 10}
                  autoComplete="off"
                />
              </Field>
            ) : (
              <span className="hidden sm:block" aria-hidden="true" />
            )}
            <Field
              label="Short description"
              optional
              error={errorFor('description')}
              hint={`${form.description.length} of ${MAX_DESCRIPTION} characters`}
              className="sm:col-span-2"
            >
              <Textarea
                id={fid('description')}
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
                onBlur={blur('description')}
                rows={4}
              />
            </Field>
            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0 sm:col-span-2">
              <legend className="mb-2 p-0 font-semibold">Status</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <StatusOption value="active" current={form.status} onChange={(v) => set('status', v)} title="Active">
                  Shown on the website and can be booked.
                </StatusOption>
                <StatusOption value="inactive" current={form.status} onChange={(v) => set('status', v)} title="Inactive">
                  Hidden from the website. Existing bookings are kept.
                </StatusOption>
              </div>
            </fieldset>
          </CardBody>
        </Card>

        {isNew && (
          <Card>
            <CardHeader title="Prices" description="Later changes apply to new bookings only." />
            <CardBody className="grid gap-5 sm:grid-cols-2">
              <Field label="12 hr price (₹)" required error={errorFor('price12')}>
                <Input
                  id={fid('price12')}
                  inputMode="decimal"
                  value={form.price12}
                  onChange={(e) => set('price12', e.target.value)}
                  onBlur={blur('price12')}
                  placeholder="1300"
                  autoComplete="off"
                />
              </Field>
              <Field label="24 hr price (₹)" required error={errorFor('price24')}>
                <Input
                  id={fid('price24')}
                  inputMode="decimal"
                  value={form.price24}
                  onChange={(e) => set('price24', e.target.value)}
                  onBlur={blur('price24')}
                  placeholder="2200"
                  autoComplete="off"
                />
              </Field>
            </CardBody>
          </Card>
        )}

        {formError && <Alert title="Couldn't save the car">{formError}</Alert>}
        {submitted && Object.keys(errors).length > 0 && !formError && (
          <Alert tone="error">Fix the highlighted fields, then save again.</Alert>
        )}
        <div className="flex flex-wrap justify-end gap-3">
          <Button type="submit" loading={saving} loadingText="Saving…" icon={<Save size={18} aria-hidden="true" />}>
            {isNew ? 'Add car' : 'Save changes'}
          </Button>
        </div>
      </form>

      {car && role === 'owner' && <DeleteCarCard car={car} />}
    </div>
  );
}

function StatusOption({
  value,
  current,
  onChange,
  title,
  children,
}: {
  value: CarStatus;
  current: CarStatus;
  onChange: (v: CarStatus) => void;
  title: string;
  children: ReactNode;
}) {
  const checked = value === current;
  return (
    <label
      className={cn(
        'flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border p-3',
        checked ? 'border-ink bg-subtle' : 'border-line-input bg-white hover:border-ink',
      )}
    >
      <input type="radio" name="car-status" value={value} checked={checked} onChange={() => onChange(value)} className="mt-1 size-5 shrink-0 accent-ink" />
      <span>
        <span className="block font-semibold">{title}</span>
        <span className="block text-sm text-muted">{children}</span>
      </span>
    </label>
  );
}

/** Owner only. A car with bookings or papers is kept for the records; set it to Inactive instead. */
function DeleteCarCard({ car }: { car: Car }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const links = useCarLinks(car.id, true);
  const [confirming, setConfirming] = useState(false);

  async function remove() {
    const photos = unwrap(await api.from('car_photos').select('id, car_id, storage_path').eq('car_id', car.id)) as Array<
      Pick<CarPhoto, 'id' | 'car_id' | 'storage_path'>
    >;
    const deleted = unwrap(await api.from('cars').delete().eq('id', car.id).select('id')) as Array<{ id: string }>;
    if (!deleted?.length) throw new AppError("This car couldn't be deleted. Only the Owner can delete cars.");
    const paths = photos.flatMap(photoFilePaths);
    if (paths.length) {
      const { error } = await api.storage.from('car-photos').remove(paths);
      if (error) toast.error('The car was deleted, but some photo files could not be removed.');
    }
    queryClient.removeQueries({ queryKey: qk.car(car.id) });
    await queryClient.invalidateQueries({ queryKey: qk.cars });
    toast.success(`${car.display_name} deleted`);
    navigate('/admin/fleet', { replace: true });
  }

  const blocked = links.data && (links.data.bookings > 0 || links.data.documents > 0);
  return (
    <Card>
      <CardHeader title="Delete car" />
      <CardBody className="flex flex-col gap-3">
        {links.isLoading ? (
          <Spinner label="Checking bookings" />
        ) : links.error ? (
          <p className="m-0 text-danger">{errorMessage(links.error)}</p>
        ) : blocked ? (
          <p className="m-0 text-[15px] text-muted">
            {links.data!.bookings > 0
              ? `This car has ${links.data!.bookings} booking${links.data!.bookings === 1 ? '' : 's'}, so it can't be deleted.`
              : 'This car has papers saved, so it can’t be deleted.'}{' '}
            Set it to Inactive to hide it from the website.
          </p>
        ) : (
          <>
            <p className="m-0 text-[15px] text-muted">This car has no bookings or papers. Deleting it also removes its photos and maintenance records.</p>
            <div>
              <Button variant="danger" size="sm" icon={<Trash2 size={16} aria-hidden="true" />} onClick={() => setConfirming(true)}>
                Delete car
              </Button>
            </div>
          </>
        )}
      </CardBody>
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Delete ${car.display_name}?`}
        description="This can't be undone."
        confirmLabel="Delete car"
        tone="danger"
        onConfirm={remove}
      />
    </Card>
  );
}
