// Car details form state and validation (FLT-02, FLT-04, section 8.1).
import {
  BADGE_PRESETS,
  BODY_TYPE_CATEGORY,
  type BodyType,
  type CarCategory,
  type CarStatus,
  type FuelType,
  type Transmission,
} from '@shared/constants.ts';
import { paiseToInput, parseRupees } from '@shared/money.ts';
import type { Car } from '@/types/db';
import { normalizeRegistration, REGISTRATION_RE, SLUG_RE, slugify } from './fleetData';

export type BadgeChoice = 'none' | 'custom' | (typeof BADGE_PRESETS)[number];

export interface CarFormState {
  display_name: string;
  slug: string;
  /** False while the slug still follows the name (new cars until the slug is edited). */
  slugEdited: boolean;
  brand: string;
  model: string;
  variant: string;
  body_type: BodyType;
  category: CarCategory;
  seats: string;
  fuel: FuelType;
  transmission: Transmission;
  colour: string;
  year: string;
  registration_number: string;
  badgeChoice: BadgeChoice;
  badgeCustom: string;
  description: string;
  sort_order: string;
  status: CarStatus;
  /** Rupees; only used when adding a car (later changes go through the Prices tab). */
  price12: string;
  price24: string;
}

export type CarFormField = keyof CarFormState;
export type CarFormErrors = Partial<Record<CarFormField, string>>;

export const MAX_DESCRIPTION = 500;
export const MAX_BADGE = 24;

const isPreset = (v: string): v is (typeof BADGE_PRESETS)[number] => (BADGE_PRESETS as readonly string[]).includes(v);

export function initialCarForm(car: Car | null, nextSortOrder: number): CarFormState {
  if (!car) {
    return {
      display_name: '',
      slug: '',
      slugEdited: false,
      brand: '',
      model: '',
      variant: '',
      body_type: 'hatchback',
      category: BODY_TYPE_CATEGORY.hatchback,
      seats: '5',
      fuel: 'petrol',
      transmission: 'manual',
      colour: '',
      year: '',
      registration_number: '',
      badgeChoice: 'none',
      badgeCustom: '',
      description: '',
      sort_order: String(nextSortOrder),
      status: 'active',
      price12: '',
      price24: '',
    };
  }
  const badge = car.badge ?? '';
  return {
    display_name: car.display_name,
    slug: car.slug,
    slugEdited: true,
    brand: car.brand,
    model: car.model,
    variant: car.variant,
    body_type: car.body_type,
    category: car.category,
    seats: String(car.seats),
    fuel: car.fuel,
    transmission: car.transmission,
    colour: car.colour,
    year: car.year ? String(car.year) : '',
    registration_number: car.registration_number ?? '',
    badgeChoice: !badge ? 'none' : isPreset(badge) ? badge : 'custom',
    badgeCustom: badge && !isPreset(badge) ? badge : '',
    description: car.description,
    sort_order: String(car.sort_order),
    status: car.status,
    price12: paiseToInput(car.price_12h_paise),
    price24: paiseToInput(car.price_24h_paise),
  };
}

/** Apply one field change, keeping derived fields in step (slug from name, category from body type). */
export function updateCarForm<K extends CarFormField>(form: CarFormState, field: K, value: CarFormState[K]): CarFormState {
  const next = { ...form, [field]: value };
  if (field === 'display_name' && !form.slugEdited) next.slug = slugify(String(value));
  if (field === 'slug') next.slugEdited = true;
  if (field === 'body_type') next.category = BODY_TYPE_CATEGORY[value as BodyType];
  if (field === 'registration_number') next.registration_number = normalizeRegistration(String(value));
  return next;
}

const isInt = (s: string) => /^-?\d+$/.test(s.trim());

export function validateCarForm(form: CarFormState, opts: { isNew: boolean; currentYear: number }): CarFormErrors {
  const e: CarFormErrors = {};
  const name = form.display_name.trim();
  if (name.length < 2 || name.length > 80) e.display_name = 'Enter a name of 2 to 80 characters, for example Kia Sonet.';
  if (!form.slug) e.slug = 'Enter a web name, for example kia-sonet.';
  else if (!SLUG_RE.test(form.slug) || form.slug.length > 60) {
    e.slug = 'Use lowercase letters, numbers and single hyphens only, for example kia-sonet.';
  }
  if (!isInt(form.seats) || Number(form.seats) < 2 || Number(form.seats) > 12) e.seats = 'Enter the number of seats, from 2 to 12.';
  if (form.year.trim()) {
    const y = Number(form.year);
    if (!isInt(form.year) || y < 1990 || y > opts.currentYear + 1) e.year = `Enter a year from 1990 to ${opts.currentYear + 1}, or leave it blank.`;
  }
  if (form.registration_number && !REGISTRATION_RE.test(form.registration_number)) {
    e.registration_number = 'Use 6 to 12 letters and numbers with no spaces, for example TS09EA1234.';
  }
  if (form.badgeChoice === 'custom') {
    const b = form.badgeCustom.trim();
    if (!b) e.badgeCustom = 'Enter the badge text, or choose No badge.';
    else if (b.length > MAX_BADGE) e.badgeCustom = `Keep the badge to ${MAX_BADGE} characters or fewer.`;
  }
  if (form.description.length > MAX_DESCRIPTION) e.description = `Shorten the description to ${MAX_DESCRIPTION} characters or fewer.`;
  if (!isInt(form.sort_order) || Number(form.sort_order) < 0) e.sort_order = 'Enter a whole number, 0 or more. Lower numbers show first.';
  if (opts.isNew) {
    const p12 = parseRupees(form.price12);
    const p24 = parseRupees(form.price24);
    if (!p12 || p12 <= 0) e.price12 = 'Enter the 12 hr price in rupees, for example 1300.';
    if (!p24 || p24 <= 0) e.price24 = 'Enter the 24 hr price in rupees, for example 2200.';
  }
  return e;
}

/** Row values for insert / update. Prices only for a new car. */
export function carPayload(form: CarFormState, isNew: boolean) {
  const badge = form.badgeChoice === 'none' ? null : form.badgeChoice === 'custom' ? form.badgeCustom.trim() : form.badgeChoice;
  const row: Record<string, unknown> = {
    display_name: form.display_name.trim(),
    slug: form.slug,
    brand: form.brand.trim(),
    model: form.model.trim(),
    variant: form.variant.trim(),
    body_type: form.body_type,
    category: form.category,
    seats: Number(form.seats),
    fuel: form.fuel,
    transmission: form.transmission,
    colour: form.colour.trim(),
    year: form.year.trim() ? Number(form.year) : null,
    registration_number: form.registration_number || null,
    badge,
    description: form.description.trim(),
    sort_order: Number(form.sort_order),
    status: form.status,
  };
  if (isNew) {
    row.price_12h_paise = parseRupees(form.price12);
    row.price_24h_paise = parseRupees(form.price24);
  }
  return row;
}
