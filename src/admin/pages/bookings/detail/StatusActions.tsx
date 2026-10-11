// BKA-04 / Section 7: the status actions this role may take, with reasons where required,
// clash and expired-paper handling on Confirm (BKA-07, FLT-08) and the unsettled check on Close.
import { useState } from 'react';
import { Link } from 'react-router';
import { Ban, CheckCircle2, KeyRound, Lock, UserX, Undo2, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { allowedTransitions, type TransitionAction } from '@shared/booking.ts';
import type { AppRole } from '@shared/constants.ts';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog, Dialog, DialogFooter } from '@/components/ui/Dialog';
import { Alert, Field, Textarea } from '@/components/ui/Field';
import { toAppError, type AppError } from '@/lib/errors';
import { formatRupees, formatWhen } from '@/lib/format';
import type { BookingWithRefs } from '@/types/db';
import { rpc, useRefresh } from './api';
import { ledgerOf } from './helpers';

const ICONS: Record<TransitionAction, typeof CheckCircle2> = {
  confirm: CheckCircle2,
  reject: XCircle,
  cancel: Ban,
  no_show: UserX,
  pickup: KeyRound,
  return: Undo2,
  close: Lock,
};

const PRIMARY: TransitionAction[] = ['confirm', 'pickup', 'return', 'close'];

type Open = null | 'reject' | 'cancel' | 'no_show' | 'close' | 'blocked';

export function StatusActions({
  booking,
  role,
  now,
  customerBlocked,
  blockReason,
  onPickup,
  onReturn,
  pickupBusy,
}: {
  booking: BookingWithRefs;
  role: AppRole | null;
  now: number;
  customerBlocked: boolean;
  blockReason: string | null;
  onPickup: () => void;
  onReturn: () => void;
  pickupBusy: boolean;
}) {
  const refresh = useRefresh();
  const [open, setOpen] = useState<Open>(null);
  const [confirming, setConfirming] = useState(false);
  const [issue, setIssue] = useState<AppError | null>(null);
  const transitions = allowedTransitions(booking.status, role);
  const beforePickupTime = now < new Date(booking.pickup_at).getTime();

  async function transition(to: string, note: string | null, override: string | null, ok: string) {
    await rpc('booking_transition', { p_booking: booking.id, p_to: to, p_note: note, p_override_reason: override });
    toast.success(ok);
    await refresh();
  }

  async function confirm(override: string | null = null) {
    setConfirming(true);
    try {
      await transition('confirmed', null, override, 'Booking confirmed');
      setIssue(null);
    } catch (err) {
      const e = toAppError(err);
      if (override) throw e;
      if (['clash', 'papers_expired', 'car_inactive'].includes(e.code ?? '')) setIssue(e);
      else toast.error(e.message);
    } finally {
      setConfirming(false);
    }
  }

  function act(action: TransitionAction) {
    switch (action) {
      case 'confirm':
        if (customerBlocked) setOpen('blocked');
        else void confirm();
        return;
      case 'pickup':
        return onPickup();
      case 'return':
        return onReturn();
      default:
        setOpen(action);
    }
  }

  if (transitions.length === 0) return null;

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {transitions.map((t) => {
          const Icon = ICONS[t.action];
          const primary = PRIMARY.includes(t.action);
          const disabled = t.action === 'no_show' && beforePickupTime;
          return (
            <Button
              key={t.action}
              variant={primary ? 'primary' : 'secondary'}
              size={primary ? 'lg' : 'md'}
              className={primary ? 'w-full sm:w-auto' : undefined}
              icon={<Icon size={18} aria-hidden="true" />}
              loading={(t.action === 'confirm' && confirming) || (t.action === 'pickup' && pickupBusy)}
              disabled={disabled}
              title={disabled ? `Available after the pickup time (${formatWhen(booking.pickup_at)})` : undefined}
              onClick={() => act(t.action)}
            >
              {t.action === 'cancel' ? 'Cancel booking' : t.action === 'close' ? 'Close booking' : t.label}
            </Button>
          );
        })}
      </div>
      {transitions.some((t) => t.action === 'no_show') && beforePickupTime && (
        <p className="m-0 mt-2 text-sm text-muted">No-show can be marked after the pickup time, {formatWhen(booking.pickup_at)}.</p>
      )}

      <ConfirmDialog
        open={open === 'blocked'}
        onClose={() => setOpen(null)}
        title="Confirm for a blocked customer?"
        description={`This customer is blocked${blockReason ? `: ${blockReason}` : ''}.`}
        confirmLabel="Confirm anyway"
        tone="danger"
        onConfirm={() => confirm()}
      />
      <ConfirmDialog
        open={open === 'reject'}
        onClose={() => setOpen(null)}
        title={`Reject ${booking.booking_code}?`}
        description="The customer is not told automatically. Use the WhatsApp rejection message after this."
        confirmLabel="Reject booking"
        tone="danger"
        reasonLabel="Reason"
        reasonHint="For example: car not available, licence not valid."
        onConfirm={(reason) => transition('rejected', reason, null, 'Booking rejected')}
      />
      <ConfirmDialog
        open={open === 'cancel'}
        onClose={() => setOpen(null)}
        title={`Cancel ${booking.booking_code}?`}
        description="The car is released for other bookings."
        confirmLabel="Cancel booking"
        tone="danger"
        reasonLabel="Reason"
        reasonHint="For example: customer called to cancel."
        onConfirm={(reason) => transition('cancelled', reason, null, 'Booking cancelled')}
      />
      <ConfirmDialog
        open={open === 'no_show'}
        onClose={() => setOpen(null)}
        title="Mark as no-show?"
        description={`The customer didn't come for the ${formatWhen(booking.pickup_at)} pickup. The car is released.`}
        confirmLabel="Mark no-show"
        tone="danger"
        reasonLabel="Note"
        reasonOptional
        onConfirm={(note) => transition('no_show', note || null, null, 'Marked as no-show')}
      />
      <CloseDialog open={open === 'close'} onClose={() => setOpen(null)} booking={booking} onSubmit={(override) => transition('closed', null, override, 'Booking closed')} />
      <ConfirmIssueDialog
        issue={issue}
        booking={booking}
        role={role}
        onClose={() => setIssue(null)}
        onOverride={(reason) => confirm(reason)}
      />
    </>
  );
}

function CloseDialog({
  open,
  onClose,
  booking,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  booking: BookingWithRefs;
  onSubmit: (override: string | null) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onClose={onClose} locked={busy} size="sm" title={`Close ${booking.booking_code}?`} description="Closing means all payments are settled and the deposit is refunded.">
      <CloseBody booking={booking} onCancel={onClose} onSubmit={onSubmit} busy={busy} setBusy={setBusy} />
    </Dialog>
  );
}

function CloseBody({
  booking,
  onCancel,
  onSubmit,
  busy,
  setBusy,
}: {
  booking: BookingWithRefs;
  onCancel: () => void;
  onSubmit: (override: string | null) => Promise<void>;
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const l = ledgerOf(booking);
  const [unsettled, setUnsettled] = useState(l.balance !== 0 || l.depositHeld !== 0);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (unsettled && !reason.trim()) return setError('Give a reason for closing with money unsettled.');
    setBusy(true);
    setError(null);
    try {
      await onSubmit(unsettled ? reason.trim() : null);
      onCancel();
    } catch (err) {
      const e = toAppError(err);
      if (e.code === 'unsettled') setUnsettled(true);
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex flex-col gap-4">
        <dl className="m-0 grid grid-cols-2 gap-2">
          <div className="rounded-xl bg-subtle px-3 py-2">
            <dt className="text-sm text-muted">{l.balance < 0 ? 'Overpaid' : 'Balance'}</dt>
            <dd className="m-0 font-bold">{formatRupees(Math.abs(l.balance))}</dd>
          </div>
          <div className="rounded-xl bg-subtle px-3 py-2">
            <dt className="text-sm text-muted">Deposit held</dt>
            <dd className="m-0 font-bold">{formatRupees(l.depositHeld)}</dd>
          </div>
        </dl>
        {unsettled ? (
          <>
            <Alert tone="warning" title="Not settled yet">
              Record the remaining payment and the deposit refund first. To close anyway, give a reason.
            </Alert>
            <Field label="Reason for closing anyway" required error={error}>
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
            </Field>
          </>
        ) : (
          <>
            <p className="m-0 flex items-center gap-2 font-semibold text-emerald-800">
              <CheckCircle2 size={18} aria-hidden="true" /> Everything is settled.
            </p>
            {error && <Alert>{error}</Alert>}
          </>
        )}
      </div>
      <DialogFooter>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Back
        </Button>
        <Button variant={unsettled ? 'danger' : 'primary'} onClick={submit} loading={busy}>
          {unsettled ? 'Close anyway' : 'Close booking'}
        </Button>
      </DialogFooter>
    </>
  );
}

interface IssueHint {
  kind?: 'booking' | 'maintenance';
  code?: string | null;
  doc_type?: string;
}

function ConfirmIssueDialog({
  issue,
  booking,
  role,
  onClose,
  onOverride,
}: {
  issue: AppError | null;
  booking: BookingWithRefs;
  role: AppRole | null;
  onClose: () => void;
  onOverride: (reason: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={Boolean(issue)} onClose={onClose} locked={busy} size="sm" title="Couldn't confirm this booking">
      {issue && <IssueBody issue={issue} booking={booking} role={role} onClose={onClose} onOverride={onOverride} busy={busy} setBusy={setBusy} />}
    </Dialog>
  );
}

function IssueBody({
  issue,
  booking,
  role,
  onClose,
  onOverride,
  busy,
  setBusy,
}: {
  issue: AppError;
  booking: BookingWithRefs;
  role: AppRole | null;
  onClose: () => void;
  onOverride: (reason: string) => Promise<void>;
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const hint: IssueHint = issue.hint && typeof issue.hint === 'object' ? (issue.hint as IssueHint) : {};
  const om = role === 'owner' || role === 'manager';
  const canOverride = issue.code === 'papers_expired' && role === 'owner';

  async function override() {
    if (!reason.trim()) return setError('Give a reason for the override.');
    setBusy(true);
    setError(null);
    try {
      await onOverride(reason.trim());
      onClose();
    } catch (err) {
      setError(toAppError(err).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex flex-col gap-4">
        <Alert>{issue.message}</Alert>
        {issue.code === 'clash' && hint.kind === 'booking' && hint.code && (
          <p className="m-0">
            Clashing booking:{' '}
            <Link to={`/admin/bookings/${hint.code}`} className="font-semibold" onClick={onClose}>
              Open {hint.code}
            </Link>
            . Move one of the bookings to another car or time.
          </p>
        )}
        {issue.code === 'clash' && hint.kind === 'maintenance' && om && (
          <p className="m-0">
            <Link to={`/admin/fleet/${booking.car_id}`} className="font-semibold" onClick={onClose}>
              See the car&apos;s maintenance
            </Link>{' '}
            or edit this booking to use another car.
          </p>
        )}
        {issue.code === 'papers_expired' && !canOverride && (
          <p className="m-0">
            Upload the renewed document on the{' '}
            <Link to={`/admin/fleet/${booking.car_id}`} className="font-semibold" onClick={onClose}>
              car page
            </Link>
            , or ask the Owner to override.
          </p>
        )}
        {canOverride && (
          <Field label="Reason to confirm anyway" required error={error} hint="Kept in the audit log.">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
          </Field>
        )}
        {!canOverride && error && <Alert>{error}</Alert>}
      </div>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Back
        </Button>
        {canOverride && (
          <Button variant="danger" onClick={override} loading={busy}>
            Override and confirm
          </Button>
        )}
      </DialogFooter>
    </>
  );
}
