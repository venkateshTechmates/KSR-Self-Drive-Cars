// Helpers for the audit log screen (AUD-01..04): filter options, record links, device names
// and before/after diffs.
import type { AuditLog } from '@/types/db';

/** Action prefixes to filter by. "bookings." etc. are row changes; "booking." etc. are named actions. */
export const ACTION_PREFIXES: Array<[string, string]> = [
  ['auth.', 'Sign-ins, sign-outs and lockouts'],
  ['bookings.', 'Booking changes and exports'],
  ['booking.', 'Booking overrides and prints'],
  ['payments.', 'Payments and exports'],
  ['booking_charges.', 'Extra charges'],
  ['handover_records.', 'Handovers and returns'],
  ['cars.', 'Car changes'],
  ['car_photos.', 'Car photos'],
  ['maintenance_windows.', 'Maintenance'],
  ['customers.', 'Customer changes'],
  ['customer.', 'Customer exports, merges and erasure'],
  ['document.', 'Document actions (upload, view, download, verify, delete)'],
  ['documents.', 'Document jobs and bulk downloads'],
  ['document_types.', 'Document types'],
  ['settings.', 'Settings changes'],
  ['policy_versions.', 'Policies published'],
  ['staff.', 'Staff accounts (invite, deactivate, resend)'],
  ['staff_profiles.', 'Staff profile changes'],
  ['user_roles.', 'Role changes'],
  ['report.', 'Report exports'],
  ['data_requests.', 'Privacy requests'],
  ['retention.', 'Retention purge'],
];

export const ENTITY_LABELS: Record<string, string> = {
  bookings: 'Booking',
  customers: 'Customer',
  cars: 'Car',
  car_photos: 'Car photo',
  maintenance_windows: 'Maintenance',
  service_logs: 'Service log',
  documents: 'Document',
  document_types: 'Document type',
  payments: 'Payment',
  booking_charges: 'Extra charge',
  handover_records: 'Handover',
  settings: 'Settings',
  policy_versions: 'Policy',
  staff_profiles: 'Staff',
  user_roles: 'Role',
  data_requests: 'Privacy request',
  reports: 'Reports',
  auth: 'Sign-in',
  system: 'System',
  app: 'App',
};

export const entityLabel = (t: string) => ENTITY_LABELS[t] ?? t;

/** Escape LIKE wildcards in text the Owner typed. */
export const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

type Json = Record<string, unknown> | null;

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

/** The booking a row is about, when the log knows it (for linking by booking code). */
export function relatedBookingId(log: Pick<AuditLog, 'entity_type' | 'entity_id' | 'before' | 'after'>): string | null {
  const row = (log.after ?? log.before ?? {}) as Record<string, unknown>;
  if (log.entity_type === 'bookings') return log.entity_id;
  if (['payments', 'booking_charges', 'handover_records', 'consents'].includes(log.entity_type)) return str(row.booking_id);
  if (log.entity_type === 'documents' && row.owner_type === 'booking') return str(row.owner_id) ?? str(row.booking_id);
  return null;
}

export interface RecordLink {
  to: string;
  label: string;
}

/** Where to go to see the record behind an entry. */
export function recordLink(log: AuditLog, bookingCode: (id: string) => string | undefined): RecordLink | null {
  const row = (log.after ?? log.before ?? {}) as Record<string, unknown>;
  const bookingId = relatedBookingId(log);
  if (bookingId) {
    const code = bookingCode(bookingId);
    return code ? { to: `/admin/bookings/${code}`, label: code } : null;
  }
  const id = log.entity_id;
  switch (log.entity_type) {
    case 'customers':
      return id ? { to: `/admin/customers/${id}`, label: 'Open customer' } : null;
    case 'cars':
      return id ? { to: `/admin/fleet/${id}`, label: 'Open car' } : null;
    case 'car_photos':
    case 'maintenance_windows':
    case 'service_logs':
      return str(row.car_id) ? { to: `/admin/fleet/${String(row.car_id)}`, label: 'Open car' } : null;
    case 'documents': {
      const ownerId = str(row.owner_id) ?? str(row.customer_id) ?? str(row.car_id);
      if (row.owner_type === 'customer' && ownerId) return { to: `/admin/customers/${ownerId}`, label: 'Open customer' };
      if (row.owner_type === 'car' && ownerId) return { to: `/admin/fleet/${ownerId}`, label: 'Open car' };
      return { to: '/admin/documents', label: 'Document centre' };
    }
    case 'staff_profiles':
    case 'user_roles':
      return { to: '/admin/staff', label: 'Staff' };
    case 'settings':
    case 'policy_versions':
    case 'document_types':
      return { to: '/admin/settings', label: 'Settings' };
    case 'data_requests':
      return { to: '/admin/requests', label: 'Privacy requests' };
    default:
      return null;
  }
}

/** "Chrome on Android", "Safari on iPhone", "Server" … from a user-agent string. */
export function shortDevice(ua: string | null): string {
  if (!ua) return '—';
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'Mac'
            : /CrOS/.test(ua)
              ? 'ChromeOS'
              : /Linux/.test(ua)
                ? 'Linux'
                : null;
  const browser = /SamsungBrowser/.test(ua)
    ? 'Samsung Internet'
    : /Edg\//.test(ua)
      ? 'Edge'
      : /OPR\/|Opera/.test(ua)
        ? 'Opera'
        : /Firefox\/|FxiOS/.test(ua)
          ? 'Firefox'
          : /Chrome\/|CriOS/.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : null;
  if (browser && os) return `${browser} on ${os}`;
  if (browser || os) return (browser ?? os)!;
  if (/Deno|node|supabase|postgres|pg_net|curl/i.test(ua)) return 'Server';
  return ua.length > 32 ? `${ua.slice(0, 31)}…` : ua;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Flatten nested objects into dot paths, two levels deep (settings values are nested JSON). */
function flatten(obj: Json, prefix = '', depth = 0, out: Record<string, unknown> = {}): Record<string, unknown> {
  if (!obj) return out;
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v) && depth < 2 && Object.keys(v).length > 0) flatten(v, path, depth + 1, out);
    else out[path] = v;
  }
  return out;
}

export interface DiffRow {
  key: string;
  before: unknown;
  after: unknown;
  changed: boolean;
}

/** Changed fields side by side. Inserts show only "after", deletes only "before". */
export function diffRows(before: Json, after: Json): DiffRow[] {
  const b = flatten(before);
  const a = flatten(after);
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort();
  const rows = keys.map((key) => ({
    key,
    before: b[key],
    after: a[key],
    changed: JSON.stringify(b[key]) !== JSON.stringify(a[key]),
  }));
  // For edits, keep only what changed; for inserts/deletes (one side empty) keep everything.
  return before && after ? rows.filter((r) => r.changed) : rows;
}

export function showValue(v: unknown): string {
  if (v === undefined) return '';
  if (v === null) return 'empty';
  if (typeof v === 'string') return v === '' ? '""' : v;
  return JSON.stringify(v);
}
