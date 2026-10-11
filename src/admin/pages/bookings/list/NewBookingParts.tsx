// Pieces of the New booking form (BKA-06): pill radios, availability and paper warnings,
// and the note shown after looking up a mobile number.
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { BOOKING_STATUS_LABELS } from '@shared/constants.ts';
import { maskDocNumber } from '@shared/documents.ts';
import { Badge } from '@/components/ui/Badges';
import { Alert } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Spinner';
import { cn } from '@/lib/cn';
import { errorMessage } from '@/lib/errors';
import { formatIsoDate, formatWhen } from '@/lib/format';
import type { Clash, Customer, PaperProblem } from '@/types/db';

export interface PillOption<T extends string> {
  value: T;
  label: ReactNode;
  extra?: ReactNode;
}

/** Radio group drawn as pills; keyboard and screen-reader behaviour stay native. */
export function PillRadios<T extends string>({
  name,
  legend,
  value,
  options,
  onChange,
  error,
  hint,
}: {
  name: string;
  legend: ReactNode;
  value: T;
  options: PillOption<T>[];
  onChange: (value: T) => void;
  error?: string | null;
  hint?: ReactNode;
}) {
  const errorId = error ? `${name}-error` : undefined;
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0" aria-describedby={errorId}>
      <legend className="mb-2 p-0 font-semibold">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <label
            key={o.value}
            className={cn(
              'inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border px-4 font-semibold whitespace-nowrap',
              'has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-action',
              value === o.value ? 'border-ink bg-ink text-white' : 'border-line-input bg-white text-ink hover:border-ink',
            )}
          >
            <input
              type="radio"
              id={`${name}-${o.value}`}
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
              className="sr-only"
            />
            {o.label}
            {o.extra && <span className="font-normal opacity-85">{o.extra}</span>}
          </label>
        ))}
      </div>
      {hint && <div className="mt-2 text-sm text-muted">{hint}</div>}
      {error && (
        <p id={errorId} className="m-0 mt-2 text-sm font-semibold text-danger">
          {error}
        </p>
      )}
    </fieldset>
  );
}

const newTab = <span className="sr-only"> (opens in a new tab)</span>;

/** Clashes (BK-10 as an admin warning) and vehicle paper problems (FLT-08) for the chosen car and time. */
export function AvailabilityWarnings({
  carId,
  ready,
  clashes,
  clashesLoading,
  clashesError,
  papers,
  todayIso,
}: {
  carId: string;
  /** Car and pickup time chosen, so availability can be checked. */
  ready: boolean;
  clashes: Clash[] | undefined;
  clashesLoading: boolean;
  clashesError: unknown;
  papers: PaperProblem[] | undefined;
  todayIso: string;
}) {
  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      {ready && clashesLoading && (
        <p className="m-0 flex items-center gap-2 text-[15px] text-muted">
          <Spinner size={16} /> Checking the car is free…
        </p>
      )}
      {ready && Boolean(clashesError) && (
        <Alert tone="warning" title="Couldn't check availability">
          {errorMessage(clashesError)} The booking will still be checked when it is saved.
        </Alert>
      )}
      {ready && clashes && clashes.length === 0 && (
        <Alert tone="success">The car is free at that time.</Alert>
      )}
      {ready && clashes && clashes.length > 0 && (
        <Alert tone="warning" title="This car is booked at that time">
          <ul className="m-0 mt-1 flex list-disc flex-col gap-1 pl-5">
            {clashes.map((c) => (
              <li key={`${c.kind}-${c.ref_id}`}>
                {c.kind === 'booking' ? (
                  <>
                    <Link to={`/admin/bookings/${encodeURIComponent(c.booking_code ?? '')}`} target="_blank" rel="noreferrer" className="font-mono font-semibold">
                      {c.booking_code}
                      {newTab}
                    </Link>{' '}
                    ({c.status ? BOOKING_STATUS_LABELS[c.status] : 'Booking'}) holds it from {formatWhen(c.starts_at)} to {formatWhen(c.ends_at)},
                    including turnaround time.
                  </>
                ) : (
                  <>
                    In maintenance{c.note ? ` (${c.note})` : ''} from {formatWhen(c.starts_at)} to {formatWhen(c.ends_at)}.
                  </>
                )}
              </li>
            ))}
          </ul>
          <p className="m-0 mt-2">
            You can still create it. It will be flagged as a clash and can't be confirmed until the clash is sorted out.
          </p>
        </Alert>
      )}
      {papers && papers.length > 0 && (
        <Alert tone="warning" title="Vehicle papers need attention">
          <ul className="m-0 mt-1 flex list-disc flex-col gap-1 pl-5">
            {papers.map((p) => (
              <li key={p.doc_type}>
                {p.label}:{' '}
                {p.problem === 'missing'
                  ? 'not uploaded'
                  : p.expiry_date && p.expiry_date < todayIso
                    ? `expired on ${formatIsoDate(p.expiry_date)}`
                    : `expires on ${p.expiry_date ? formatIsoDate(p.expiry_date) : '—'}, before the return time`}
              </li>
            ))}
          </ul>
          <p className="m-0 mt-2">
            The booking can be created, but not confirmed until the papers are valid, unless the Owner overrides.{' '}
            <Link to={`/admin/fleet/${carId}`} target="_blank" rel="noreferrer">
              Open the car{newTab}
            </Link>
          </p>
        </Alert>
      )}
    </div>
  );
}

export type CustomerMatch = Pick<
  Customer,
  'id' | 'full_name' | 'email' | 'dl_number' | 'dl_expiry' | 'blocked' | 'block_reason' | 'identity_verified'
>;

export type Lookup =
  | { state: 'idle' }
  | { state: 'loading'; phone: string }
  | { state: 'found'; phone: string; customer: CustomerMatch }
  | { state: 'new'; phone: string };

/** What we know about the mobile number entered (CUS-01: one customer per mobile number). */
export function LookupNote({ lookup, dlTyped, returnDateIso }: { lookup: Lookup; dlTyped: string; returnDateIso: string | null }) {
  if (lookup.state === 'idle') return null;
  if (lookup.state === 'loading') {
    return (
      <p className="m-0 flex items-center gap-2 text-sm text-muted" role="status">
        <Spinner size={14} /> Looking up this number…
      </p>
    );
  }
  if (lookup.state === 'new') {
    return (
      <p className="m-0 text-sm text-muted" role="status">
        New customer. Their record is created with this booking.
      </p>
    );
  }
  const c = lookup.customer;
  const dlDiffers = Boolean(c.dl_number && dlTyped && c.dl_number !== dlTyped);
  const dlExpires = Boolean(c.dl_expiry && returnDateIso && c.dl_expiry < returnDateIso);
  return (
    <div className="flex flex-col gap-2" role="status">
      <Alert tone="info">
        <span className="flex flex-wrap items-center gap-2">
          <span>
            Existing customer: <strong>{c.full_name}</strong>.
          </span>
          {c.identity_verified && <Badge tone="green">Identity verified</Badge>}
        </span>
        <span className="mt-1 block text-sm">
          We filled in the details on file. Check them with the customer.
          {c.identity_verified && ' Their verified name stays as it is.'}
        </span>
        <Link to={`/admin/customers/${c.id}`} target="_blank" rel="noreferrer" className="mt-1 inline-block text-sm">
          Open customer{newTab}
        </Link>
      </Alert>
      {c.blocked && (
        <Alert tone="warning" title="This customer is blocked">
          {c.block_reason ? `Reason: ${c.block_reason}. ` : ''}You can still create the booking; it will be flagged.
        </Alert>
      )}
      {dlExpires && c.dl_expiry && (
        <Alert tone="warning" title="Licence expires before the return time">
          The licence on file expires on {formatIsoDate(c.dl_expiry)}. The booking will be flagged.
        </Alert>
      )}
      {dlDiffers && (
        <p className="m-0 text-sm text-muted">
          The licence on file ends in {maskDocNumber(c.dl_number)?.slice(-4)}. A different number is saved in the booking notes, not on the
          customer.
        </p>
      )}
    </div>
  );
}
