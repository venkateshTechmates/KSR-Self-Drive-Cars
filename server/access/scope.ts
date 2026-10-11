// Visibility rules from the permission matrix (PRD 2.2), as SQL fragments shared by the
// data API policies and the business functions, so both enforce exactly the same thing.
//   Staff: bookings from yesterday to tomorrow (IST) plus any car currently out;
//          customers and their KYC documents only on the day of their booking.
import { addDaysIso, istDateIso, istStartOfDay } from '../../shared/time.ts';
import type { AppRole } from '../../shared/constants.ts';
import { one, type Param } from '../db/connection.ts';
import { isOwnerOrManager, type Ctx } from './context.ts';

export interface Sql {
  sql: string;
  params: Param[];
}

export const sql = (s: string, ...params: Param[]): Sql => ({ sql: s, params });
export const TRUE: Sql = { sql: '1', params: [] };
export const FALSE: Sql = { sql: '0', params: [] };

export function and(...parts: Sql[]): Sql {
  const real = parts.filter((p) => p.sql !== '1');
  if (real.some((p) => p.sql === '0')) return FALSE;
  if (!real.length) return TRUE;
  return { sql: real.map((p) => `(${p.sql})`).join(' AND '), params: real.flatMap((p) => p.params) };
}

export function or(...parts: Sql[]): Sql {
  const real = parts.filter((p) => p.sql !== '0');
  if (real.some((p) => p.sql === '1')) return TRUE;
  if (!real.length) return FALSE;
  return { sql: real.map((p) => `(${p.sql})`).join(' OR '), params: real.flatMap((p) => p.params) };
}

/** IST day boundaries as UTC ISO strings. */
export function istBounds(now: Date = new Date()) {
  const today = istDateIso(now);
  return {
    todayStart: istStartOfDay(today).toISOString(),
    tomorrowStart: istStartOfDay(addDaysIso(today, 1)).toISOString(),
    windowStart: istStartOfDay(addDaysIso(today, -1)).toISOString(),
    windowEnd: istStartOfDay(addDaysIso(today, 2)).toISOString(),
  };
}

/** Booking (alias) visible to Staff: active, or pickup/return within yesterday..tomorrow. */
export function staffBookingSql(alias: string, now: Date = new Date()): Sql {
  const b = istBounds(now);
  return sql(
    `${alias}.status = 'active' OR (${alias}.pickup_at >= ? AND ${alias}.pickup_at < ?) OR (${alias}.return_due_at >= ? AND ${alias}.return_due_at < ?)`,
    b.windowStart,
    b.windowEnd,
    b.windowStart,
    b.windowEnd,
  );
}

/** Customer (id expression) has a booking today (or a car out now). */
export function customerTodaySql(customerIdExpr: string, now: Date = new Date()): Sql {
  const b = istBounds(now);
  return sql(
    `EXISTS (SELECT 1 FROM bookings bt WHERE bt.customer_id = ${customerIdExpr} AND bt.status NOT IN ('rejected', 'cancelled')
       AND (bt.status = 'active' OR (bt.pickup_at >= ? AND bt.pickup_at < ?) OR (bt.return_due_at >= ? AND bt.return_due_at < ?)))`,
    b.todayStart,
    b.tomorrowStart,
    b.todayStart,
    b.tomorrowStart,
  );
}

/** Which bookings (alias) the caller may see. */
export function bookingVisibleSql(ctx: Ctx, alias: string): Sql {
  if (isOwnerOrManager(ctx)) return TRUE;
  if (ctx.role === 'staff') return staffBookingSql(alias);
  return FALSE;
}

/** Which customers (alias) the caller may see (AC-10). */
export function customerVisibleSql(ctx: Ctx, alias: string): Sql {
  if (isOwnerOrManager(ctx)) return TRUE;
  if (ctx.role === 'staff') return customerTodaySql(`${alias}.id`);
  return FALSE;
}

/** Which documents (alias) the caller may view (DOC-05/06, 2.2). */
export function documentVisibleSql(ctx: Ctx, alias: string): Sql {
  if (ctx.system) return TRUE;
  const role = ctx.role;
  if (!role) return FALSE;
  const typeAllows = sql(
    `EXISTS (SELECT 1 FROM document_types dt WHERE dt.key = ${alias}.doc_type AND EXISTS (SELECT 1 FROM json_each(dt.view_roles) WHERE value = ?))`,
    role,
  );
  const notDeleted = role === 'owner' ? TRUE : sql(`${alias}.deleted_at IS NULL`);
  if (role !== 'staff') return and(typeAllows, notDeleted);
  const staffBooking = staffBookingSql('bb');
  return and(
    typeAllows,
    notDeleted,
    or(
      and(sql(`${alias}.owner_type = 'customer'`), customerTodaySql(`${alias}.customer_id`)),
      and(sql(`${alias}.owner_type = 'booking'`), {
        sql: `EXISTS (SELECT 1 FROM bookings bb WHERE bb.id = ${alias}.booking_id AND (${staffBooking.sql}))`,
        params: staffBooking.params,
      }),
    ),
  );
}

export function canSeeBooking(ctx: Ctx, bookingId: string): boolean {
  const v = bookingVisibleSql(ctx, 'b');
  return Boolean(one(`SELECT 1 FROM bookings b WHERE b.id = ? AND (${v.sql})`, bookingId, ...v.params));
}

export function customerHasBookingToday(customerId: string): boolean {
  // The fragment's own placeholder for the customer id comes first, then its date bounds.
  const v = customerTodaySql('?');
  return one<{ ok: number }>(`SELECT (${v.sql}) AS ok`, customerId, ...v.params)?.ok === 1;
}

export function canViewDocument(ctx: Ctx, documentId: string): boolean {
  const v = documentVisibleSql(ctx, 'd');
  return Boolean(one(`SELECT 1 FROM documents d WHERE d.id = ? AND (${v.sql})`, documentId, ...v.params));
}

/** Staff may view KYC documents but never download them (2.2). */
export function canDownloadDocument(ctx: Ctx, documentId: string): boolean {
  if (!canViewDocument(ctx, documentId)) return false;
  if (ctx.system) return true;
  const t = one<{ is_kyc: number; download_roles: string }>(
    `SELECT t.is_kyc, t.download_roles FROM documents d JOIN document_types t ON t.key = d.doc_type WHERE d.id = ?`,
    documentId,
  );
  if (!t || !ctx.role) return false;
  if (ctx.role === 'staff' && t.is_kyc) return false;
  return (JSON.parse(t.download_roles) as AppRole[]).includes(ctx.role);
}
