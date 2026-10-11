// Shown only when the app runs without a Supabase project (local preview). In production
// every car, price and policy comes from the database (WEB-07).
import type { PublicCar, PublicPolicy } from '@/types/db';

type DemoCar = [slug: string, name: string, brand: string, body: PublicCar['body_type'], cat: PublicCar['category'], seats: number, fuel: PublicCar['fuel'], p12: number, p24: number, badge: string | null];

const CARS: DemoCar[] = [
  ['kia-sonet', 'Kia Sonet', 'Kia', 'compact_suv', 'suv', 5, 'petrol', 1800, 3500, 'Premium'],
  ['toyota-glanza', 'Toyota Glanza', 'Toyota', 'hatchback', 'hatch', 5, 'petrol', 1500, 2500, null],
  ['maruti-suzuki-fronx', 'Maruti Suzuki Fronx', 'Maruti Suzuki', 'crossover', 'suv', 5, 'petrol', 1500, 2500, null],
  ['tata-nexon-new', 'Tata Nexon (New)', 'Tata', 'compact_suv', 'suv', 5, 'petrol', 2000, 2800, 'New model'],
  ['tata-nexon-old', 'Tata Nexon (Old)', 'Tata', 'compact_suv', 'suv', 5, 'petrol', 1700, 2500, null],
  ['maruti-victoris-cng', 'Victoris CNG', 'Maruti Suzuki', 'suv', 'suv', 5, 'cng', 1800, 3000, null],
  ['tata-punch-cng', 'Tata Punch CNG', 'Tata', 'micro_suv', 'suv', 5, 'cng', 1500, 2300, 'Best value'],
  ['hyundai-i20', 'Hyundai i20', 'Hyundai', 'hatchback', 'hatch', 5, 'petrol', 1500, 2500, null],
  ['maruti-baleno', 'Maruti Baleno', 'Maruti Suzuki', 'hatchback', 'hatch', 5, 'petrol', 1300, 2500, null],
  ['maruti-ertiga', 'Ertiga (7 Seater)', 'Maruti Suzuki', 'mpv', 'mpv', 7, 'petrol', 2000, 3500, '7 seater'],
  ['maruti-xl6-cng', 'XL6 CNG', 'Maruti Suzuki', 'premium_mpv', 'mpv', 6, 'cng', 2000, 3500, null],
];

export const DEMO_CARS: PublicCar[] = CARS.map(([slug, name, brand, body, cat, seats, fuel, p12, p24, badge], i) => ({
  id: `00000000-0000-4000-a000-${String(i + 1).padStart(12, '0')}`,
  slug,
  display_name: name,
  brand,
  model: name,
  body_type: body,
  category: cat,
  seats,
  fuel,
  transmission: 'manual',
  badge,
  description: '',
  price_12h_paise: p12 * 100,
  price_24h_paise: p24 * 100,
  sort_order: (i + 1) * 10,
  photos: [],
}));

export const DEMO_POLICIES: PublicPolicy[] = (['privacy', 'terms', 'cancellation'] as const).map((kind) => ({
  kind,
  locale: 'en',
  version: 1,
  title: { privacy: 'Privacy notice', terms: 'Terms of rental', cancellation: 'Cancellation policy' }[kind],
  body_md: '_Preview mode: connect the Supabase project to show the published text._',
  published_at: '2026-10-11T00:00:00Z',
  label: `${kind}-en-v1`,
}));
