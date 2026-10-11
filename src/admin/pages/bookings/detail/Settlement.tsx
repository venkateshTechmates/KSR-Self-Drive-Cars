// After the return (HND-03/04, BKA-10): trip figures, suggested charges, and the deposit refund
// worked out as deposit held − unpaid balance.
import { useState } from 'react';
import { CheckCircle2, Plus } from 'lucide-react';
import toast from 'react-hot-toast';
import { CHARGE_KIND_LABELS, type ChargeKind } from '@shared/constants.ts';
import { DEFAULT_SETTINGS } from '@shared/settings.ts';
import { Button } from '@/components/ui/Button';
import { Alert, Field, Input } from '@/components/ui/Field';
import { errorMessage } from '@/lib/errors';
import { formatRupees, paiseToInput, parseRupees, pluralize } from '@/lib/format';
import type { BookingCharge, BookingWithRefs } from '@/types/db';
import { isOwnerOrManager, useAuth } from '@/admin/auth/AuthProvider';
import { useSetting } from '@/admin/hooks/queries';
import { rpc, useCharges, usePayments, useRefresh } from './api';
import { ChargeForm, ChargeList } from './Charges';
import { fuelDiffLabel, ledgerOf, type SettlementSummary } from './helpers';
import { PaymentForm } from './Payments';
import { MoneyInput, Stat, StepHeading } from './ui';

interface Suggestion {
  key: string;
  kind: ChargeKind;
  title: string;
  /** Null when there is no rule to suggest an amount. */
  suggested: number | null;
  basis: string;
  note: string;
  added: (charges: BookingCharge[]) => boolean;
}

export function SettlementPanel({
  booking,
  summary,
  allowRemove = true,
}: {
  booking: BookingWithRefs;
  summary: SettlementSummary;
  /** Removing a charge opens a confirmation dialog; switch off when already inside a dialog. */
  allowRemove?: boolean;
}) {
  const charges = useCharges(booking.id);
  const rules = useSetting('booking_rules').data ?? DEFAULT_SETTINGS.booking_rules;
  const [adding, setAdding] = useState(false);
  const rows = charges.data ?? [];
  const ledger = ledgerOf(booking);
  const fuelDiff = summary.fuel_diff_quarters ?? 0;

  const suggestions: Suggestion[] = [];
  if (summary.late_hours > 0) {
    suggestions.push({
      key: 'late',
      kind: 'late',
      title: `Late return: ${pluralize(summary.late_hours, 'hour')}`,
      suggested: summary.suggested_late_fee_paise > 0 ? summary.suggested_late_fee_paise : null,
      basis: `${pluralize(summary.late_hours, 'hour')} × ${formatRupees(rules.late_fee_per_hour_paise)}, after a ${rules.late_grace_minutes}-minute grace period`,
      note: `${pluralize(summary.late_hours, 'hour')} late`,
      added: (list) => list.some((c) => c.kind === 'late'),
    });
  }
  if (summary.extra_km > 0) {
    suggestions.push({
      key: 'km',
      kind: 'other',
      title: `Extra km: ${summary.extra_km} km over the package limit`,
      suggested: summary.suggested_km_charge_paise > 0 ? summary.suggested_km_charge_paise : null,
      basis: `${summary.extra_km} km × ${formatRupees(rules.extra_km_rate_paise ?? 0)} per km`,
      note: `Extra km: ${summary.extra_km} km over the limit`,
      added: (list) => list.some((c) => c.kind === 'other' && c.note.startsWith('Extra km')),
    });
  }
  if (fuelDiff < 0) {
    suggestions.push({
      key: 'fuel',
      kind: 'fuel',
      title: `Fuel: ${fuelDiffLabel(fuelDiff)}`,
      suggested: null,
      basis: rules.fuel_policy,
      note: `Fuel ${fuelDiffLabel(fuelDiff)}`,
      added: (list) => list.some((c) => c.kind === 'fuel'),
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3" aria-label="Trip summary">
        <StepHeading>Trip summary</StepHeading>
        <dl className="m-0 grid grid-cols-2 gap-2 lg:grid-cols-4" aria-live="polite">
          <Stat
            label="Km driven"
            value={summary.km_driven === null ? '—' : `${summary.km_driven.toLocaleString('en-IN')} km`}
            note={summary.extra_km > 0 ? `${summary.extra_km} km over the limit` : undefined}
          />
          <Stat label="Fuel" value={fuelDiff === 0 ? 'Same' : fuelDiffLabel(fuelDiff).replace(' than at pickup', '')} tone={fuelDiff < 0 ? 'danger' : undefined} />
          <Stat
            label="Late"
            value={summary.late_hours > 0 ? pluralize(summary.late_hours, 'hour') : 'On time'}
            tone={summary.late_hours > 0 ? 'danger' : 'success'}
            note={summary.late_hours > 0 && summary.suggested_late_fee_paise > 0 ? `Suggested fee ${formatRupees(summary.suggested_late_fee_paise)}` : undefined}
          />
          <Stat label="Deposit held" value={formatRupees(ledger.depositHeld)} />
        </dl>
      </section>

      <section className="flex flex-col gap-3" aria-label="Charges">
        <StepHeading>Charges</StepHeading>
        {suggestions.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {suggestions.map((s) => (
              <SuggestedCharge key={s.key} booking={booking} s={s} added={s.added(rows)} />
            ))}
          </ul>
        )}
        {rows.length > 0 ? (
          allowRemove ? (
            <ChargeList booking={booking} charges={rows} />
          ) : (
            <ChargeSummary charges={rows} />
          )
        ) : (
          <p className="m-0 text-muted">No charges added yet.</p>
        )}
        {adding ? (
          <div className="rounded-xl border border-line-card p-4">
            <ChargeForm booking={booking} onDone={() => setAdding(false)} onCancel={() => setAdding(false)} />
          </div>
        ) : (
          <div>
            <Button variant="secondary" size="sm" icon={<Plus size={16} aria-hidden="true" />} onClick={() => setAdding(true)}>
              Add damage, cleaning or other charge
            </Button>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3" aria-label="Balance and deposit">
        <StepHeading>Balance and deposit</StepHeading>
        <DepositSettlement booking={booking} />
      </section>
    </div>
  );
}

function ChargeSummary({ charges }: { charges: BookingCharge[] }) {
  return (
    <ul className="m-0 list-none p-0">
      {charges.map((c) => (
        <li key={c.id} className="flex justify-between gap-3 border-b border-line-card py-2 last:border-0">
          <span className="min-w-0">
            <span className="font-semibold">{CHARGE_KIND_LABELS[c.kind]}</span>
            {c.note && <span className="block text-sm text-muted">{c.note}</span>}
          </span>
          <span className="font-bold">{formatRupees(c.amount_paise)}</span>
        </li>
      ))}
    </ul>
  );
}

function SuggestedCharge({ booking, s, added }: { booking: BookingWithRefs; s: Suggestion; added: boolean }) {
  const refresh = useRefresh();
  const [amount, setAmount] = useState(s.suggested !== null ? paiseToInput(s.suggested) : '');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const paise = parseRupees(amount);
  const changed = s.suggested !== null && paise !== s.suggested;

  if (added) {
    return (
      <li className="flex items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2.5 text-emerald-900">
        <CheckCircle2 size={18} aria-hidden="true" />
        <span>
          <strong>{s.title}</strong>: charge added.
        </span>
      </li>
    );
  }

  async function add() {
    const e: Record<string, string> = {};
    if (paise === null || paise <= 0) e.amount = 'Enter an amount above zero.';
    if (changed && !reason.trim()) e.reason = `Say why the amount differs from the suggested ${formatRupees(s.suggested)}.`;
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const note = changed ? `${s.note}. Changed from ${formatRupees(s.suggested)}: ${reason.trim()}` : s.note;
      await rpc('add_booking_charge', { p_booking: booking.id, p_kind: s.kind, p_amount_paise: paise, p_note: note, p_document_id: null });
      toast.success(`${CHARGE_KIND_LABELS[s.kind]} charge of ${formatRupees(paise)} added`);
      await refresh();
    } catch (err) {
      setErrors({ submit: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-amber-300 bg-amber-50 p-3">
      <div>
        <p className="m-0 font-semibold">{s.title}</p>
        <p className="m-0 text-sm text-ink-2">
          {s.suggested !== null ? `Suggested ${formatRupees(s.suggested)}: ${s.basis}.` : s.basis}
        </p>
      </div>
      <div className="grid items-start gap-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
        <Field label="Amount" error={errors.amount}>
          <MoneyInput value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        {changed && (
          <Field label="Reason for the change" required error={errors.reason}>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        )}
      </div>
      {errors.submit && <Alert>{errors.submit}</Alert>}
      <div>
        <Button size="sm" onClick={add} loading={busy} loadingText="Adding…">
          Add {CHARGE_KIND_LABELS[s.kind].toLowerCase()} charge
        </Button>
      </div>
    </li>
  );
}

type Mode = null | 'refund' | 'collect' | 'apply' | 'overpaid';

/** PAY-02/HND-04: balance, deposit held and what to give back. */
export function DepositSettlement({ booking }: { booking: BookingWithRefs }) {
  const { role } = useAuth();
  const om = isOwnerOrManager(role);
  const refresh = useRefresh();
  const payments = usePayments(booking.id);
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const l = ledgerOf(booking);
  const keep = Math.min(l.unpaid, Math.max(0, l.depositHeld));
  const depositMethod = payments.data?.find((p) => p.type === 'deposit')?.method ?? 'cash';
  const settled = l.balance === 0 && l.depositHeld === 0;

  async function applyDeposit() {
    setBusy(true);
    setError(null);
    try {
      await rpc('record_payment', {
        p_booking: booking.id,
        p_amount_paise: keep,
        p_type: 'deposit_refund',
        p_method: depositMethod,
        p_reference: null,
        p_note: 'Kept from the deposit for the unpaid balance',
        p_receipt_document_id: null,
        p_received_at: null,
      });
      try {
        await rpc('record_payment', {
          p_booking: booking.id,
          p_amount_paise: keep,
          p_type: booking.extra_charges_paise > 0 ? 'extra' : 'rent',
          p_method: depositMethod,
          p_reference: null,
          p_note: 'Paid from the deposit',
          p_receipt_document_id: null,
          p_received_at: null,
        });
      } catch (err) {
        setError(
          `The deposit was reduced by ${formatRupees(keep)}, but the matching payment wasn't saved: ${errorMessage(err)} Record a ${formatRupees(keep)} payment with the note "Paid from the deposit".`,
        );
        return;
      }
      toast.success(`${formatRupees(keep)} of the deposit used for the balance`);
      setMode(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      await refresh('payments');
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <dl className="m-0 grid grid-cols-2 gap-2 lg:grid-cols-4" aria-live="polite">
        <Stat label="Total due" value={formatRupees(booking.total_paise)} />
        <Stat label="Paid" value={formatRupees(booking.paid_paise)} />
        <Stat
          label={l.balance < 0 ? 'Overpaid' : 'Balance'}
          value={formatRupees(Math.abs(l.balance))}
          tone={l.balance > 0 ? 'danger' : l.balance === 0 ? 'success' : undefined}
        />
        <Stat label="Deposit held" value={formatRupees(l.depositHeld)} />
      </dl>
      {l.depositHeld > 0 && (
        <p className="m-0 rounded-xl border border-line-card bg-subtle px-4 py-3" aria-live="polite">
          Deposit to return: <strong className="text-lg">{formatRupees(l.refundDue)}</strong>
          <span className="block text-sm text-muted">
            Deposit held {formatRupees(l.depositHeld)} − unpaid balance {formatRupees(l.unpaid)}
          </span>
        </p>
      )}
      {settled && (
        <Alert tone="success" title="Everything is settled">
          {booking.status === 'returned' ? 'The booking can be closed.' : 'No money is owed either way.'}
        </Alert>
      )}
      {l.shortfall > 0 && (
        <Alert tone="warning" title={`Collect ${formatRupees(l.shortfall)} more`}>
          {l.depositHeld > 0 ? "The deposit doesn't cover the unpaid balance." : 'The booking has an unpaid balance.'}
        </Alert>
      )}
      {error && <Alert>{error}</Alert>}

      {mode === null && (
        <div className="flex flex-wrap gap-2">
          {l.refundDue > 0 && om && (
            <Button onClick={() => setMode('refund')}>Record deposit refund of {formatRupees(l.refundDue)}</Button>
          )}
          {keep > 0 && om && (
            <Button variant="secondary" onClick={() => setMode('apply')}>
              Use {formatRupees(keep)} of the deposit for the balance
            </Button>
          )}
          {l.unpaid > 0 && (
            <Button variant="secondary" onClick={() => setMode('collect')}>
              Record a payment
            </Button>
          )}
          {l.balance < 0 && om && (
            <Button variant="secondary" onClick={() => setMode('overpaid')}>
              Refund {formatRupees(-l.balance)} overpaid
            </Button>
          )}
        </div>
      )}
      {l.refundDue > 0 && !om && (
        <p className="m-0 text-sm text-muted">Ask the Owner or a Manager to record the deposit refund of {formatRupees(l.refundDue)}.</p>
      )}

      {mode === 'apply' && (
        <div className="flex flex-col gap-3 rounded-xl border border-line-card p-4">
          <p className="m-0">
            This records a deposit refund of {formatRupees(keep)} marked &ldquo;Kept for the unpaid balance&rdquo; and a {formatRupees(keep)} payment
            &ldquo;Paid from the deposit&rdquo;, so the balance is cleared.
          </p>
          <div className="flex flex-wrap justify-end gap-3">
            <Button variant="secondary" onClick={() => setMode(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={applyDeposit} loading={busy} loadingText="Saving…">
              Use the deposit
            </Button>
          </div>
        </div>
      )}
      {mode === 'refund' && (
        <div className="rounded-xl border border-line-card p-4">
          <PaymentForm
            booking={booking}
            initialType="deposit_refund"
            lockType
            initialAmountPaise={l.refundDue}
            initialNote={l.unpaid > 0 ? `Deposit returned less ${formatRupees(l.unpaid)} kept for the balance` : 'Deposit returned after the trip'}
            submitLabel="Record deposit refund"
            onDone={() => setMode(null)}
            onCancel={() => setMode(null)}
          />
        </div>
      )}
      {mode === 'collect' && (
        <div className="rounded-xl border border-line-card p-4">
          <PaymentForm
            booking={booking}
            initialType={booking.extra_charges_paise > 0 ? 'extra' : 'rent'}
            initialAmountPaise={l.unpaid}
            onDone={() => setMode(null)}
            onCancel={() => setMode(null)}
          />
        </div>
      )}
      {mode === 'overpaid' && (
        <div className="rounded-xl border border-line-card p-4">
          <PaymentForm
            booking={booking}
            initialType="refund"
            lockType
            initialAmountPaise={-l.balance}
            initialNote="Paid more than the total"
            onDone={() => setMode(null)}
            onCancel={() => setMode(null)}
          />
        </div>
      )}
    </div>
  );
}
