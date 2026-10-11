// Public data comes only from the public views (9.2): public_cars, public_settings, public_policies.
// Without a configured backend (local preview), the bundled demo fleet is shown instead.
import { useQuery } from '@tanstack/react-query';
import type { Locale, PolicyKind } from '@shared/constants.ts';
import { withDefaults, type BookingRules, type BusinessSettings } from '@shared/settings.ts';
import { isSupabaseConfigured, supabase } from '@/integrations/supabase/client';
import { unwrap } from '@/lib/errors';
import type { PublicCar, PublicPolicy } from '@/types/db';
import { DEMO_CARS, DEMO_POLICIES } from '../demoData';

export function usePublicCars() {
  return useQuery({
    queryKey: ['public', 'cars'],
    queryFn: async (): Promise<PublicCar[]> => {
      if (!isSupabaseConfigured) return DEMO_CARS;
      return unwrap(await supabase.from('public_cars').select('*').order('sort_order').order('display_name')) as PublicCar[];
    },
    staleTime: 5 * 60_000,
  });
}

export interface PublicConfig {
  business: BusinessSettings;
  rules: BookingRules;
}

export function usePublicConfig() {
  return useQuery({
    queryKey: ['public', 'settings'],
    queryFn: async (): Promise<PublicConfig> => {
      if (!isSupabaseConfigured) return { business: withDefaults('business', null), rules: withDefaults('booking_rules', null) };
      const rows = unwrap(await supabase.from('public_settings').select('key, value')) as Array<{ key: string; value: unknown }>;
      const get = (k: string) => rows.find((r) => r.key === k)?.value;
      return { business: withDefaults('business', get('business')), rules: withDefaults('booking_rules', get('booking_rules')) };
    },
    staleTime: 5 * 60_000,
  });
}

/** Latest version of a policy in each available language (WEB-10, DP-07). */
export function usePublicPolicies(kind: PolicyKind) {
  return useQuery({
    queryKey: ['public', 'policy', kind],
    queryFn: async (): Promise<PublicPolicy[]> => {
      if (!isSupabaseConfigured) return DEMO_POLICIES.filter((p) => p.kind === kind);
      return unwrap(await supabase.from('public_policies').select('*').eq('kind', kind)) as PublicPolicy[];
    },
    staleTime: 10 * 60_000,
  });
}

export const pickPolicy = (policies: PublicPolicy[] | undefined, locale: Locale) =>
  policies?.find((p) => p.locale === locale) ?? policies?.find((p) => p.locale === 'en') ?? null;

export interface BusyWindow {
  car_id: string;
  starts_at: string;
  ends_at: string;
  kind: 'booking' | 'maintenance';
}

/** Busy windows (no personal data) for showing "Not available" in the booking form (FLE-05). */
export function useBusyWindows(fromIso: string | null, toIso: string | null) {
  return useQuery({
    queryKey: ['public', 'busy', fromIso, toIso],
    enabled: isSupabaseConfigured && Boolean(fromIso && toIso),
    queryFn: async () =>
      unwrap(await supabase.rpc('public_busy_windows', { p_from: fromIso, p_to: toIso })) as BusyWindow[],
    staleTime: 60_000,
  });
}
