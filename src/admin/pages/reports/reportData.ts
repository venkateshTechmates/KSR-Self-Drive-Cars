// Data helpers shared by Reports and Payments: paged fetches, ledger totals, export logging
// and CSV rows. Exports never carry KYC data or document numbers (RPT-06).
import {
  PACKAGE_LABELS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_TYPE_LABELS,
  type BookingPackage,
  type BookingStatus,
  type PaymentType,
} from '@shared/constants.ts';
import { supabase } from '@/integrations/supabase/client';
import type { CsvValue } from '@/lib/csv';
import { toAppError, unwrap } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import type { Car, Customer, Payment } from '@/types/db';

const PAGE_SIZE = 1000;

/** Fetch every row of a query, 1,000 at a time (PostgREST caps a single response). */
export async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
  maxRows = 50_000,
): Promise<T[]> {
  const out: T[] = [];
  for (let start = 0; start < maxRows; start += PAGE_SIZE) {
    const { data, error } = await page(start, start + PAGE_SIZE - 1);
    if (error) throw toAppError(error);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}

/** Write the export to the audit log first; the file is only produced if that succeeds (AUD-01). */
export async function logExport(
  action: 'report.export' | 'bookings.export' | 'payments.export',
  entityType: string,
  meta: Record<string, unknown>,
): Promise<void> {
  unwrap(await supabase.rpc('log_client_event', { p_action: action, p_entity_type: entityType, p_entity_id: null, p_meta: meta }));
}

// ---------------------------------------------------------------- payments

export interface PaymentWithBooking extends Payment {
  booking: {
    id: string;
    booking_code: string;
    status: BookingStatus;
    package: BookingPackage;
    car: Pick<Car, 'id' | 'display_name' | 'registration_number'> | null;
    customer: Pick<Customer, 'id' | 'full_name'> | null;
  } | null;
}

export const PAYMENT_SELECT =
  '*, booking:bookings(id, booking_code, status, package, car:cars(id, display_name, registration_number), customer:customers(id, full_name))';

/** Effect of a payment on revenue: rent and extra count, refunds subtract, deposits never count. */
export function revenueEffect(p: Pick<Payment, 'type' | 'amount_paise'>): number {
  if (p.type === 'rent' || p.type === 'extra') return p.amount_paise;
  if (p.type === 'refund') return -p.amount_paise;
  return 0;
}

export type LedgerTotals = Record<PaymentType, number> & { net: number; depositsHeld: number; count: number };

export function ledgerTotals(rows: Array<Pick<Payment, 'type' | 'amount_paise'>>): LedgerTotals {
  const t: LedgerTotals = { rent: 0, deposit: 0, extra: 0, refund: 0, deposit_refund: 0, net: 0, depositsHeld: 0, count: rows.length };
  for (const p of rows) t[p.type] += p.amount_paise;
  t.net = t.rent + t.extra - t.refund;
  t.depositsHeld = t.deposit - t.deposit_refund;
  return t;
}

// ---------------------------------------------------------------- formatting

/** Rupees with two decimals and no symbol or grouping, so spreadsheets read it as a number. */
export const csvRupees = (paise: number | null | undefined) => ((paise ?? 0) / 100).toFixed(2);

const trimNum = (n: number) => (n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10));

/** Axis label: ₹950, ₹1.2K, ₹3.4L, ₹1.1Cr. */
export function compactRupees(paise: number): string {
  const rupees = paise / 100;
  const abs = Math.abs(rupees);
  const sign = rupees < 0 ? '−' : '';
  if (abs >= 1e7) return `${sign}₹${trimNum(abs / 1e7)}Cr`;
  if (abs >= 1e5) return `${sign}₹${trimNum(abs / 1e5)}L`;
  if (abs >= 1e3) return `${sign}₹${trimNum(abs / 1e3)}K`;
  return `${sign}₹${Math.round(abs)}`;
}

export const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

// ---------------------------------------------------------------- CSV rows

export const PAYMENT_CSV_HEADERS = [
  'Received (IST)',
  'Booking code',
  'Car',
  'Package',
  'Customer',
  'Type',
  'Method',
  'Amount (₹)',
  'Effect on revenue (₹)',
  'Reference',
  'Received by',
  'Note',
];

/** One CSV row per payment. Only the customer's name is included: no mobile, no document data. */
export function paymentCsvRows(rows: PaymentWithBooking[], staffName: (id: string | null) => string): CsvValue[][] {
  return rows.map((p) => [
    formatDateTime(p.received_at),
    p.booking?.booking_code ?? '',
    p.booking?.car?.display_name ?? '',
    p.booking ? PACKAGE_LABELS[p.booking.package] : '',
    p.booking?.customer?.full_name ?? '',
    PAYMENT_TYPE_LABELS[p.type],
    PAYMENT_METHOD_LABELS[p.method],
    csvRupees(p.amount_paise),
    csvRupees(revenueEffect(p)),
    p.reference ?? '',
    staffName(p.received_by),
    p.note,
  ]);
}
