// Per-table access rules for the data API — a port of the row-level security policies in
// supabase/migrations/20261011000500_rls_and_grants.sql. Anything not listed is not reachable.
// Business writes with rules of their own (bookings, payments, documents…) go through RPCs.
import { isAdmin, isOwner, isOwnerOrManager, type Ctx } from '../access/context.ts';
import { bookingVisibleSql, customerVisibleSql, documentVisibleSql, FALSE, sql, TRUE, type Sql } from '../access/scope.ts';

type Rule = (ctx: Ctx, alias: string) => Sql;

export interface TablePolicy {
  read?: Rule;
  insert?: (ctx: Ctx) => boolean;
  update?: Rule;
  delete?: Rule;
}

const when = (test: (ctx: Ctx) => boolean): Rule => (ctx) => (test(ctx) ? TRUE : FALSE);
const everyone: Rule = () => TRUE;
const bookingChild: Rule = (ctx, a) => {
  const v = bookingVisibleSql(ctx, 'pb');
  return v.sql === '1' ? TRUE : v.sql === '0' ? FALSE : { sql: `EXISTS (SELECT 1 FROM bookings pb WHERE pb.id = ${a}.booking_id AND (${v.sql}))`, params: v.params };
};

export const POLICIES: Record<string, TablePolicy> = {
  // Public views (9.2): visitors read only these.
  public_cars: { read: everyone },
  public_settings: { read: everyone },
  public_policies: { read: everyone },

  staff_profiles: {
    read: (ctx, a) => (isAdmin(ctx) ? TRUE : ctx.userId ? sql(`${a}.user_id = ?`, ctx.userId) : FALSE),
    update: when(isOwner),
  },
  user_roles: { read: (ctx, a) => (isOwnerOrManager(ctx) ? TRUE : ctx.userId ? sql(`${a}.user_id = ?`, ctx.userId) : FALSE) },

  settings: { read: when(isAdmin), insert: isOwner, update: when(isOwner) },
  // Versioned: new versions are inserted, old ones never edited (SET-03).
  policy_versions: { read: when(isAdmin), insert: isOwner },
  document_types: { read: when(isAdmin), insert: isOwner, update: when(isOwner) },

  cars: { read: when(isAdmin), insert: isOwnerOrManager, update: when(isOwnerOrManager), delete: when(isOwner) },
  car_photos: { read: when(isAdmin), insert: isOwnerOrManager, update: when(isOwnerOrManager), delete: when(isOwnerOrManager) },
  car_price_history: { read: when(isOwnerOrManager) },
  maintenance_windows: { read: when(isAdmin), insert: isOwnerOrManager, update: when(isOwnerOrManager), delete: when(isOwnerOrManager) },
  service_logs: { read: when(isOwnerOrManager), insert: isOwnerOrManager, update: when(isOwnerOrManager), delete: when(isOwnerOrManager) },

  // Staff: customers only on the day of their booking (AC-10).
  customers: { read: (ctx, a) => customerVisibleSql(ctx, a), insert: isOwnerOrManager, update: when(isOwnerOrManager) },
  consents: { read: when(isOwnerOrManager) },

  // Staff: bookings from yesterday to tomorrow, plus cars currently out.
  bookings: { read: (ctx, a) => bookingVisibleSql(ctx, a) },
  booking_events: { read: bookingChild },
  handover_records: { read: bookingChild },
  booking_charges: { read: bookingChild },
  payments: { read: bookingChild },

  documents: { read: (ctx, a) => documentVisibleSql(ctx, a) },
  upload_links: { read: when(isOwnerOrManager) },

  data_requests: { read: when(isOwnerOrManager), insert: isOwnerOrManager, update: when(isOwnerOrManager), delete: when(isOwnerOrManager) },

  // AUD-03: read-only, Owner only.
  audit_logs: { read: when(isOwner) },
  outbox: { read: when(isOwner) },
};

/** Columns never returned through the data API, even to allowed readers. */
export const HIDDEN_COLUMNS: Record<string, string[]> = {
  upload_links: ['token_hash'],
};
