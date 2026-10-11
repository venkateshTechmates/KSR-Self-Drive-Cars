// Data access and helpers for the fleet screens (FLT-01..09). Query keys sit under
// qk.cars / qk.bookings / qk.documents so the shared invalidations refresh them.
import { useQuery } from '@tanstack/react-query';
import type { BookingPackage, BookingStatus } from '@shared/constants.ts';
import { BLOCKING_VEHICLE_DOC_TYPES, expiryState, type ExpiryState } from '@shared/documents.ts';
import { supabase } from '@/integrations/supabase/client';
import { carPhotoPaths } from '@/lib/carPhotos';
import { unwrap } from '@/lib/errors';
import type { Car, CarPhoto, CarPriceHistory, DocumentType, MaintenanceWindow, PaperProblem, ServiceLog } from '@/types/db';
import { qk } from '../../hooks/queries';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const fleetKeys = {
  photosAll: [...qk.cars, 'photos-all'] as const,
  maintenanceNow: [...qk.cars, 'maintenance-now'] as const,
  photos: (carId: string) => [...qk.car(carId), 'photos'] as const,
  prices: (carId: string) => [...qk.car(carId), 'prices'] as const,
  maintenance: (carId: string) => [...qk.car(carId), 'maintenance'] as const,
  serviceLogs: (carId: string) => [...qk.car(carId), 'service-logs'] as const,
  nextBookings: [...qk.bookings, 'fleet-next'] as const,
  carBookings: (carId: string) => [...qk.bookings, 'car', carId] as const,
  carLinks: (carId: string) => [...qk.bookings, 'car-links', carId] as const,
  fleetPapers: [...qk.documents, 'fleet-papers'] as const,
  paperProblems: (carId: string) => [...qk.documentsFor('car', carId), 'problems'] as const,
};

// ------------------------------------------------------------------ helpers

/** "Kia Sonet (2024)" → "kia-sonet-2024": lowercase letters, digits and single hyphens. */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const REGISTRATION_RE = /^[A-Z0-9]{6,12}$/;

/** Registration numbers are stored upper-case without spaces or hyphens, e.g. TS09EA1234. */
export const normalizeRegistration = (input: string) => input.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** The three WebP files of a car photo: {id}.webp, {id}-800.webp and {id}-400.webp. */
export function photoFilePaths(photo: Pick<CarPhoto, 'id' | 'car_id' | 'storage_path'>): string[] {
  if (/\.webp$/.test(photo.storage_path)) {
    return [photo.storage_path, photo.storage_path.replace(/\.webp$/, '-800.webp'), photo.storage_path.replace(/\.webp$/, '-400.webp')];
  }
  const p = carPhotoPaths(photo.car_id, photo.id);
  return [p.full, p.medium, p.small];
}

/** Cover photo, or the first photo in display order. */
export function coverOf(car: Pick<Car, 'id' | 'cover_photo_id'>, photos: CarPhoto[]): CarPhoto | null {
  const own = photos.filter((p) => p.car_id === car.id);
  return own.find((p) => p.id === car.cover_photo_id) ?? own[0] ?? null;
}

/** "Ravi Kumar Reddy" → "Ravi R." */
export function shortName(full: string | null | undefined): string {
  const parts = (full ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

// ------------------------------------------------------------------ single car

export function useCar(id: string) {
  return useQuery({
    queryKey: qk.car(id),
    enabled: UUID_RE.test(id),
    queryFn: async () => unwrap(await supabase.from('cars').select('*').eq('id', id).maybeSingle()) as Car | null,
  });
}

export function useCarPhotos(carId: string) {
  return useQuery({
    queryKey: fleetKeys.photos(carId),
    queryFn: async () =>
      unwrap(await supabase.from('car_photos').select('*').eq('car_id', carId).order('sort_order').order('created_at')) as CarPhoto[],
  });
}

export function usePriceHistory(carId: string) {
  return useQuery({
    queryKey: fleetKeys.prices(carId),
    queryFn: async () =>
      unwrap(
        await supabase.from('car_price_history').select('*').eq('car_id', carId).order('changed_at', { ascending: false }).limit(50),
      ) as CarPriceHistory[],
  });
}

export function useMaintenanceWindows(carId: string) {
  return useQuery({
    queryKey: fleetKeys.maintenance(carId),
    queryFn: async () =>
      unwrap(
        await supabase.from('maintenance_windows').select('*').eq('car_id', carId).order('starts_at', { ascending: false }).limit(200),
      ) as MaintenanceWindow[],
  });
}

export function useServiceLogs(carId: string) {
  return useQuery({
    queryKey: fleetKeys.serviceLogs(carId),
    queryFn: async () =>
      unwrap(
        await supabase
          .from('service_logs')
          .select('*')
          .eq('car_id', carId)
          .order('service_date', { ascending: false })
          .order('created_at', { ascending: false }),
      ) as ServiceLog[],
  });
}

export function usePaperProblems(carId: string) {
  return useQuery({
    queryKey: fleetKeys.paperProblems(carId),
    queryFn: async () =>
      (unwrap(await supabase.rpc('car_paper_problems', { p_car: carId, p_until: new Date().toISOString() })) ?? []) as PaperProblem[],
  });
}

export interface CarBookingRow {
  id: string;
  booking_code: string;
  status: BookingStatus;
  package: BookingPackage;
  pickup_at: string;
  return_due_at: string;
  total_paise: number;
  customer: { id: string; full_name: string } | null;
}

/** Booking history for one car, latest first. */
export function useCarBookings(carId: string) {
  return useQuery({
    queryKey: fleetKeys.carBookings(carId),
    queryFn: async () =>
      unwrap(
        await supabase
          .from('bookings')
          .select('id, booking_code, status, package, pickup_at, return_due_at, total_paise, customer:customers(id, full_name)')
          .eq('car_id', carId)
          .order('pickup_at', { ascending: false })
          .limit(200),
      ) as unknown as CarBookingRow[],
  });
}

/** How many bookings and documents point at a car (a car with either can't be deleted). */
export function useCarLinks(carId: string, enabled: boolean) {
  return useQuery({
    queryKey: fleetKeys.carLinks(carId),
    enabled,
    queryFn: async () => {
      const b = await supabase.from('bookings').select('id', { count: 'exact', head: true }).eq('car_id', carId);
      unwrap(b);
      const d = await supabase.from('documents').select('id', { count: 'exact', head: true }).eq('car_id', carId);
      unwrap(d);
      return { bookings: b.count ?? 0, documents: d.count ?? 0 };
    },
  });
}

// ------------------------------------------------------------------ fleet list (FLT-01)

/** All car photos (at most 8 per car), for cover thumbnails on the list. */
export function useAllCarPhotos() {
  return useQuery({
    queryKey: fleetKeys.photosAll,
    queryFn: async () =>
      unwrap(await supabase.from('car_photos').select('*').order('sort_order').order('created_at')) as CarPhoto[],
    staleTime: 60_000,
  });
}

export interface NextBooking {
  id: string;
  booking_code: string;
  car_id: string;
  status: BookingStatus;
  pickup_at: string;
}

/** Next Requested / Confirmed pickup per car. */
export function useNextBookings() {
  return useQuery({
    queryKey: fleetKeys.nextBookings,
    queryFn: async () => {
      const rows = unwrap(
        await supabase
          .from('bookings')
          .select('id, booking_code, car_id, status, pickup_at')
          .in('status', ['requested', 'confirmed'])
          .gte('pickup_at', new Date().toISOString())
          .order('pickup_at')
          .limit(1000),
      ) as NextBooking[];
      const byCar = new Map<string, NextBooking>();
      for (const r of rows) if (!byCar.has(r.car_id)) byCar.set(r.car_id, r);
      return byCar;
    },
    staleTime: 60_000,
  });
}

/** Maintenance windows running right now, by car. */
export function useMaintenanceNow() {
  return useQuery({
    queryKey: fleetKeys.maintenanceNow,
    queryFn: async () => {
      const nowIso = new Date().toISOString();
      const rows = unwrap(
        await supabase.from('maintenance_windows').select('*').lte('starts_at', nowIso).gt('ends_at', nowIso),
      ) as MaintenanceWindow[];
      return new Map(rows.map((r) => [r.car_id, r]));
    },
    staleTime: 60_000,
  });
}

export interface PaperDoc {
  id: string;
  car_id: string;
  doc_type: string;
  expiry_date: string | null;
  status: string;
  version: number;
  created_at: string;
}

/** Current (latest, not superseded or rejected) blocking vehicle papers for every car. */
export function useFleetPapers(types: string[]) {
  return useQuery({
    queryKey: [...fleetKeys.fleetPapers, types.join(',')],
    queryFn: async () =>
      unwrap(
        await supabase
          .from('documents')
          .select('id, car_id, doc_type, expiry_date, status, version, created_at')
          .eq('owner_type', 'car')
          .is('deleted_at', null)
          .not('status', 'in', '(superseded,rejected)')
          .in('doc_type', types),
      ) as PaperDoc[],
    staleTime: 60_000,
  });
}

/** Paper types whose expiry blocks bookings (FLT-08), from Settings with a safe fallback. */
export function blockingPaperTypes(types: DocumentType[] | undefined): Array<{ key: string; label: string }> {
  const short: Record<string, string> = { insurance: 'Insurance', puc: 'PUC', permit: 'Permit' };
  const fromDb = (types ?? []).filter((t) => t.owner_type === 'car' && t.active && t.blocks_booking_when_expired);
  if (fromDb.length) return fromDb.map((t) => ({ key: t.key, label: short[t.key] ?? t.label }));
  return BLOCKING_VEHICLE_DOC_TYPES.map((k) => ({ key: k, label: short[k] ?? k }));
}

export interface PaperWarning {
  key: string;
  label: string;
  state: 'missing' | Exclude<ExpiryState, 'valid'>;
  expiry: string | null;
}

/** Missing, expired or expiring (≤ 30 days) blocking papers for one car (FLT-01, DOC-12). */
export function paperWarnings(carId: string, docs: PaperDoc[], types: Array<{ key: string; label: string }>, todayIso: string): PaperWarning[] {
  const out: PaperWarning[] = [];
  for (const t of types) {
    const current = docs
      .filter((d) => d.car_id === carId && d.doc_type === t.key)
      .sort((a, b) => b.version - a.version || b.created_at.localeCompare(a.created_at))[0];
    if (!current) {
      out.push({ key: t.key, label: t.label, state: 'missing', expiry: null });
      continue;
    }
    const state = expiryState(current.expiry_date, todayIso);
    if (state === 'expired' || state === 'expiring_soon') out.push({ key: t.key, label: t.label, state, expiry: current.expiry_date });
  }
  return out;
}
