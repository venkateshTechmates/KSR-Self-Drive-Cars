// BKA-09: extend an Active booking by 12 or 24 hours, or custom hours at the extra-hour rate,
// after an availability check. A different price needs a reason.
import { useState } from 'react';
import { Link } from 'react-router';
import toast from 'react-hot-toast';
import { extensionPrice, extraHourRate } from '@shared/booking.ts';
import { MS_HOUR } from '@shared/time.ts';
import { DEFAULT_SETTINGS } from '@shared/settings.ts';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogFooter } from '@/components/ui/Dialog';
import { Alert, Field, Input } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Spinner';
import { errorMessage, toAppError } from '@/lib/errors';
import { formatRupees, formatWhen, paiseToInput, parseRupees } from '@/lib/format';
import type { BookingWithRefs } from '@/types/db';
import { useCars, useSetting } from '@/admin/hooks/queries';
import { rpc, useCarClashes, useRefresh } from './api';
import { ChoiceChips, MoneyInput } from './ui';

type Kind = '12h' | '24h' | 'hours';
const KIND_OPTIONS = [
  { value: '12h' as const, label: '+12 hrs' },
  { value: '24h' as const, label: '+24 hrs' },
  { value: 'hours' as const, label: 'Custom hours' },
];

export function ExtendDialog({ open, onClose, booking }: { open: boolean; onClose: () => void; booking: BookingWithRefs }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onClose={onClose} locked={busy} size="md" title="Extend the booking" description={`Now due back ${formatWhen(booking.return_due_at)}.`}>
      <ExtendForm booking={booking} onClose={onClose} busy={busy} setBusy={setBusy} />
    </Dialog>
  );
}

function ExtendForm({ booking, onClose, busy, setBusy }: { booking: BookingWithRefs; onClose: () => void; busy: boolean; setBusy: (b: boolean) => void }) {
  const refresh = useRefresh();
  const cars = useCars();
  const rules = useSetting('booking_rules').data ?? DEFAULT_SETTINGS.booking_rules;
  const car = cars.data?.find((c) => c.id === booking.car_id);
  const [kind, setKind] = useState<Kind>('12h');
  const [hoursText, setHoursText] = useState('3');
  const [amount, setAmount] = useState('');
  const [amountTouched, setAmountTouched] = useState(false);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const hours = kind === '12h' ? 12 : kind === '24h' ? 24 : Number(hoursText);
  const hoursOk = Number.isInteger(hours) && hours >= 1 && hours <= 240;
  const computed = car && hoursOk ? extensionPrice(car, kind === 'hours' ? { kind, hours } : { kind }, rules) : null;
  const shown = amountTouched ? amount : paiseToInput(computed);
  const amountPaise = parseRupees(shown);
  const overridden = amountTouched && amountPaise !== null && amountPaise !== computed;
  const from = new Date(booking.return_due_at);
  const newReturn = hoursOk ? new Date(from.getTime() + hours * MS_HOUR) : null;
  const clashes = useCarClashes(booking.car_id, from, newReturn, booking.id);
  const clashList = clashes.data ?? [];

  function changeKind(next: Kind) {
    setKind(next);
    setAmountTouched(false);
  }

  async function save() {
    const e: Record<string, string> = {};
    if (!hoursOk) e.hours = 'Enter whole hours between 1 and 240.';
    if (amountPaise === null) e.amount = 'Enter the price in rupees, for example 600.';
    if (overridden && !reason.trim()) e.reason = 'A different price needs a reason.';
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const res = await rpc<{ return_due_at: string; price_paise: number }>('extend_booking', {
        p_booking: booking.id,
        p_kind: kind,
        p_hours: kind === 'hours' ? hours : null,
        p_amount_paise: overridden || computed === null ? amountPaise : null,
        p_reason: reason.trim() || null,
      });
      toast.success(`Extended. Now due back ${formatWhen(res.return_due_at)} (${formatRupees(res.price_paise)} added).`);
      await refresh();
      onClose();
    } catch (err) {
      const ae = toAppError(err);
      setErrors(ae.code === 'price_reason' ? { reason: ae.message } : { submit: ae.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex flex-col gap-5">
        <ChoiceChips legend="Extend by" options={KIND_OPTIONS} value={kind} onChange={changeKind} />
        {kind === 'hours' && (
          <Field
            label="Hours"
            error={errors.hours}
            hint={car ? `Extra-hour rate ${formatRupees(extraHourRate(car, rules))} per hour.` : undefined}
          >
            <Input
              inputMode="numeric"
              value={hoursText}
              onChange={(e) => {
                setHoursText(e.target.value.replace(/\D/g, ''));
                setAmountTouched(false);
              }}
              className="max-w-[10rem]"
            />
          </Field>
        )}
        <div aria-live="polite" className="flex flex-col gap-2">
          {newReturn && (
            <p className="m-0">
              New return time: <strong>{formatWhen(newReturn)}</strong>
            </p>
          )}
          {clashes.isFetching && !clashes.data ? (
            <p className="m-0 flex items-center gap-2 text-sm text-muted">
              <Spinner size={16} /> Checking availability…
            </p>
          ) : clashes.error ? (
            <Alert tone="warning">Couldn&apos;t check availability: {errorMessage(clashes.error)}</Alert>
          ) : clashList.length > 0 ? (
            <Alert title="The car is not free for the whole extension">
              <ul className="m-0 pl-5">
                {clashList.map((c) => (
                  <li key={c.ref_id}>
                    {c.kind === 'booking' ? (
                      <>
                        Next booking{' '}
                        <Link to={`/admin/bookings/${c.booking_code}`} className="font-semibold">
                          {c.booking_code}
                        </Link>{' '}
                        from {formatWhen(c.starts_at)}
                      </>
                    ) : (
                      <>Maintenance from {formatWhen(c.starts_at)}</>
                    )}
                  </li>
                ))}
              </ul>
              <p className="m-0 mt-1">Extend for less time, or move that booking first.</p>
            </Alert>
          ) : clashes.data ? (
            <p className="m-0 text-sm font-semibold text-emerald-800">The car is free for the extension.</p>
          ) : null}
        </div>
        <Field label="Price" error={errors.amount} hint={computed !== null ? `Standard price ${formatRupees(computed)}.` : undefined}>
          <MoneyInput
            value={shown}
            onChange={(e) => {
              setAmount(e.target.value);
              setAmountTouched(true);
            }}
          />
        </Field>
        {overridden && (
          <Field label="Reason for the different price" required error={errors.reason}>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        )}
        {errors.submit && <Alert>{errors.submit}</Alert>}
      </div>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={save} loading={busy} loadingText="Saving…" disabled={clashList.length > 0}>
          Extend booking
        </Button>
      </DialogFooter>
    </>
  );
}
