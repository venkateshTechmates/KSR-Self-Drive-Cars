// Query hooks shared by several admin screens. Area-specific queries live next to their pages.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { withDefaults, type SettingsKey, type SettingsMap } from '@shared/settings.ts';
import { supabase } from '@/integrations/supabase/client';
import { unwrap } from '@/lib/errors';
import type { Car, DocumentType, StaffProfile, UserRole } from '@/types/db';

/** Query keys. Invalidate by prefix, e.g. queryClient.invalidateQueries({ queryKey: qk.bookings }). */
export const qk = {
  settings: ['settings'] as const,
  setting: (key: string) => ['settings', key] as const,
  cars: ['cars'] as const,
  car: (id: string) => ['cars', id] as const,
  documentTypes: ['document-types'] as const,
  staff: ['staff'] as const,
  bookings: ['bookings'] as const,
  booking: (code: string) => ['bookings', 'detail', code] as const,
  customers: ['customers'] as const,
  customer: (id: string) => ['customers', id] as const,
  documents: ['documents'] as const,
  documentsFor: (ownerType: string, ownerId: string | null) => ['documents', ownerType, ownerId] as const,
  payments: ['payments'] as const,
  dashboard: ['dashboard'] as const,
  audit: ['audit'] as const,
  dataRequests: ['data-requests'] as const,
};

export function useSetting<K extends SettingsKey>(key: K) {
  return useQuery({
    queryKey: qk.setting(key),
    queryFn: async (): Promise<SettingsMap[K]> => {
      const row = unwrap(await supabase.from('settings').select('value').eq('key', key).maybeSingle());
      return withDefaults(key, (row as { value: unknown } | null)?.value);
    },
    staleTime: 5 * 60_000,
  });
}

export function useSaveSetting<K extends SettingsKey>(key: K) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (value: SettingsMap[K]) => {
      const { data: auth } = await supabase.auth.getUser();
      unwrap(await supabase.from('settings').upsert({ key, value, updated_by: auth.user?.id ?? null }).select('key'));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.settings }),
  });
}

/** All cars (active and inactive), in display order. */
export function useCars() {
  return useQuery({
    queryKey: qk.cars,
    queryFn: async () => unwrap(await supabase.from('cars').select('*').order('sort_order').order('display_name')) as Car[],
    staleTime: 60_000,
  });
}

export function useDocumentTypes() {
  return useQuery({
    queryKey: qk.documentTypes,
    queryFn: async () => unwrap(await supabase.from('document_types').select('*').order('sort_order')) as DocumentType[],
    staleTime: 10 * 60_000,
  });
}

export interface StaffMember extends StaffProfile {
  role: UserRole['role'] | null;
}

/** Staff names for "who did it" labels. */
export function useStaffDirectory() {
  return useQuery({
    queryKey: qk.staff,
    queryFn: async () => {
      const profiles = unwrap(await supabase.from('staff_profiles').select('*').order('full_name')) as StaffProfile[];
      const roles = (unwrap(await supabase.from('user_roles').select('user_id, role')) ?? []) as Pick<UserRole, 'user_id' | 'role'>[];
      const roleOf = new Map(roles.map((r) => [r.user_id, r.role]));
      return profiles.map((p) => ({ ...p, role: roleOf.get(p.user_id) ?? null })) as StaffMember[];
    },
    staleTime: 5 * 60_000,
  });
}

/** Returns a function that maps a user id to a display name ("System" for null). */
export function useStaffName() {
  const { data } = useStaffDirectory();
  return (id: string | null | undefined) => {
    if (!id) return 'System';
    return data?.find((s) => s.user_id === id)?.full_name ?? 'Staff member';
  };
}
