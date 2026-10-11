// Status colours from Appendix C. Colour is always paired with a text label.
import type { ReactNode } from 'react';
import {
  BOOKING_STATUS_LABELS,
  DOC_STATUS_LABELS,
  FLAG_LABELS,
  PAYMENT_STATUS_LABELS,
  type BookingFlag,
  type BookingStatus,
  type DocStatus,
  type PaymentStatus,
} from '@shared/constants.ts';
import type { DisplayStatus } from '@shared/booking.ts';
import { EXPIRY_LABELS, type ExpiryState } from '@shared/documents.ts';
import { cn } from '@/lib/cn';

export type Tone = 'amber' | 'blue' | 'green' | 'red' | 'teal' | 'grey' | 'dark' | 'outline';

const toneClass: Record<Tone, string> = {
  amber: 'bg-amber-100 text-amber-900 ring-amber-300',
  blue: 'bg-blue-100 text-blue-900 ring-blue-300',
  green: 'bg-emerald-100 text-emerald-900 ring-emerald-300',
  red: 'bg-red-100 text-red-900 ring-red-300',
  teal: 'bg-teal-100 text-teal-900 ring-teal-300',
  grey: 'bg-zinc-100 text-zinc-700 ring-zinc-300',
  dark: 'bg-ink text-white ring-ink',
  outline: 'bg-white text-ink ring-line-input',
};

export function Badge({ tone = 'grey', children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[13px] font-semibold ring-1 ring-inset',
        toneClass[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const STATUS_TONE: Record<DisplayStatus, Tone> = {
  requested: 'amber',
  confirmed: 'blue',
  active: 'green',
  overdue: 'red',
  returned: 'teal',
  closed: 'grey',
  rejected: 'grey',
  cancelled: 'grey',
  no_show: 'grey',
};

export const statusTone = (s: DisplayStatus) => STATUS_TONE[s];
export const isStruck = (s: DisplayStatus) => s === 'rejected' || s === 'cancelled' || s === 'no_show';

export function StatusPill({ status, className }: { status: DisplayStatus; className?: string }) {
  return (
    <Badge tone={STATUS_TONE[status]} className={className}>
      {status === 'overdue' ? 'Overdue' : BOOKING_STATUS_LABELS[status as BookingStatus]}
    </Badge>
  );
}

/** Booking code, struck through for Rejected / Cancelled / No-show (Appendix C). */
export function BookingCode({ code, status, className }: { code: string; status: DisplayStatus; className?: string }) {
  return <span className={cn('font-mono text-[14px] font-semibold', isStruck(status) && 'text-muted line-through', className)}>{code}</span>;
}

const PAYMENT_TONE: Record<PaymentStatus, Tone> = { unpaid: 'amber', part_paid: 'blue', paid: 'green', refunded: 'grey' };
export function PaymentPill({ status }: { status: PaymentStatus }) {
  return <Badge tone={PAYMENT_TONE[status]}>{PAYMENT_STATUS_LABELS[status]}</Badge>;
}

const DOC_TONE: Record<DocStatus, Tone> = { pending: 'amber', verified: 'green', rejected: 'red', expired: 'red', superseded: 'grey' };
export function DocStatusPill({ status }: { status: DocStatus }) {
  return <Badge tone={DOC_TONE[status]}>{DOC_STATUS_LABELS[status]}</Badge>;
}

const EXPIRY_TONE: Record<ExpiryState, Tone> = { valid: 'green', expiring_soon: 'amber', expired: 'red' };
export function ExpiryPill({ state }: { state: ExpiryState | null }) {
  if (!state) return null;
  return <Badge tone={EXPIRY_TONE[state]}>{EXPIRY_LABELS[state]}</Badge>;
}

export function FlagPills({ flags }: { flags: BookingFlag[] }) {
  if (!flags.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {flags.map((f) => (
        <Badge key={f} tone={f === 'clash' || f === 'blocked_customer' ? 'red' : 'amber'}>
          {FLAG_LABELS[f]}
        </Badge>
      ))}
    </span>
  );
}
