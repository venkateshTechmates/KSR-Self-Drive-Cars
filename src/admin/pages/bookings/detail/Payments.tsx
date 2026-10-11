// PAY-01..03: record payments, deposits and refunds against the booking, and list them.
import { useRef, useState, type ReactNode } from 'react';
import { Paperclip, Plus, Receipt } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  PAYMENT_TYPE_LABELS,
  PAYMENT_TYPES,
  REFUND_TYPES,
  type AppRole,
  type PaymentMethod,
  type PaymentType,
} from '@shared/constants.ts';
import { fromIstLocalInput, toIstLocalInput } from '@shared/time.ts';
import { Badge } from '@/components/ui/Badges';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogFooter } from '@/components/ui/Dialog';
import { Alert, Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Card, CardHeader, EmptyState } from '@/components/ui/Layout';
import { Spinner } from '@/components/ui/Spinner';
import { uploadDocument } from '@/lib/documents';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatRupees, paiseToInput, parseRupees } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import type { BookingWithRefs, Payment } from '@/types/db';
import { isOwnerOrManager, useAuth } from '@/admin/auth/AuthProvider';
import { useStaffName } from '@/admin/hooks/queries';
import { rpc, usePayments, useRefresh } from './api';
import { ledgerOf, suggestedPayment } from './helpers';
import { ChoiceChips, MoneyInput } from './ui';

const METHOD_OPTIONS = PAYMENT_METHODS.map((m) => ({ value: m, label: PAYMENT_METHOD_LABELS[m] }));

const isRefund = (t: PaymentType) => REFUND_TYPES.includes(t);

/** Payment types this role may record (PAY-03: refunds are Owner/Manager only). */
const paymentTypesFor = (role: AppRole | null) => PAYMENT_TYPES.filter((t) => isOwnerOrManager(role) || !isRefund(t));

interface PaymentFormProps {
  booking: BookingWithRefs;
  initialType?: PaymentType;
  /** Fix the type (e.g. the deposit refund step of a return). */
  lockType?: boolean;
  initialAmountPaise?: number;
  initialNote?: string;
  submitLabel?: string;
  /** Render buttons in a sticky <DialogFooter> (inside a dialog) or inline. */
  inDialog?: boolean;
  onDone: () => void;
  onCancel?: () => void;
  onBusyChange?: (busy: boolean) => void;
}

export function PaymentForm({
  booking,
  initialType,
  lockType,
  initialAmountPaise,
  initialNote = '',
  submitLabel,
  inDialog,
  onDone,
  onCancel,
  onBusyChange,
}: PaymentFormProps) {
  const { role } = useAuth();
  const om = isOwnerOrManager(role);
  const refresh = useRefresh();
  const now = useNow();
  const ledger = ledgerOf(booking);
  const types = paymentTypesFor(role);
  const startType: PaymentType = initialType && types.includes(initialType) ? initialType : ledger.unpaid > 0 ? 'rent' : 'deposit';

  const [type, setType] = useState<PaymentType>(startType);
  const [amount, setAmount] = useState(paiseToInput(initialAmountPaise ?? suggestedPayment(booking, startType)) || '');
  const [amountTouched, setAmountTouched] = useState(false);
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [reference, setReference] = useState('');
  const [receivedAt, setReceivedAt] = useState(() => toIstLocalInput(now));
  const [note, setNote] = useState(initialNote);
  const [receipt, setReceipt] = useState<File | null>(null);
  /** Receipt already saved by an earlier attempt; uploading the same file again is refused as a duplicate. */
  const [receiptDocId, setReceiptDocId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusyState] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const refund = isRefund(type);

  const setBusy = (b: boolean) => {
    setBusyState(b);
    onBusyChange?.(b);
  };

  function changeType(next: PaymentType) {
    setType(next);
    if (!amountTouched) setAmount(paiseToInput(suggestedPayment(booking, next)) || '');
  }

  async function submit() {
    const e: Record<string, string> = {};
    const paise = parseRupees(amount);
    if (paise === null || paise <= 0) e.amount = 'Enter an amount above zero, for example 1800.';
    else if (type === 'deposit_refund' && paise > ledger.depositHeld) e.amount = `The deposit held is ${formatRupees(ledger.depositHeld)}. Enter that or less.`;
    if (refund && !note.trim()) e.note = 'Give a reason for the refund.';
    const when = fromIstLocalInput(receivedAt);
    if (!when) e.receivedAt = 'Enter the date and time the money was received.';
    else if (when.getTime() > now + 5 * 60_000) e.receivedAt = "The time can't be in the future.";
    setErrors(e);
    if (Object.keys(e).length) return;

    setBusy(true);
    try {
      let receiptId = receiptDocId;
      if (!receiptId && receipt) {
        const res = await uploadDocument({ ownerType: 'booking', ownerId: booking.id, docType: 'payment_receipt', file: receipt, notes: `${PAYMENT_TYPE_LABELS[type]} ${formatRupees(paise)}` });
        receiptId = res.document.id;
        setReceiptDocId(receiptId);
      }
      await rpc('record_payment', {
        p_booking: booking.id,
        p_amount_paise: paise,
        p_type: type,
        p_method: method,
        p_reference: reference.trim() || null,
        p_note: note.trim(),
        p_receipt_document_id: receiptId,
        p_received_at: when!.toISOString(),
      });
      toast.success(`${PAYMENT_TYPE_LABELS[type]} of ${formatRupees(paise)} recorded`);
      await refresh('payments', 'documents');
      onDone();
    } catch (err) {
      setErrors({ submit: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  const buttons: ReactNode = (
    <>
      {onCancel && (
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      )}
      <Button onClick={submit} loading={busy} loadingText="Saving…">
        {submitLabel ?? (refund ? 'Record refund' : 'Record payment')}
      </Button>
    </>
  );

  return (
    <>
      <div className="flex flex-col gap-4">
        {lockType ? (
          <p className="m-0">
            <span className="text-muted">Type: </span>
            <strong>{PAYMENT_TYPE_LABELS[type]}</strong>
          </p>
        ) : (
          <Field label="Type">
            <Select value={type} onChange={(e) => changeType(e.target.value as PaymentType)}>
              {types.map((t) => (
                <option key={t} value={t}>
                  {PAYMENT_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field
          label="Amount"
          error={errors.amount}
          hint={
            type === 'deposit_refund'
              ? `Deposit held: ${formatRupees(ledger.depositHeld)}.`
              : type === 'deposit'
                ? `Deposit required: ${formatRupees(booking.deposit_paise)}; held: ${formatRupees(ledger.depositHeld)}.`
                : `Balance due: ${formatRupees(ledger.balance)}.`
          }
        >
          <MoneyInput
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              setAmountTouched(true);
            }}
          />
        </Field>
        <ChoiceChips legend="Method" options={METHOD_OPTIONS} value={method} onChange={setMethod} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Reference" optional hint="UPI, card or bank reference number.">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Received at (IST)" error={errors.receivedAt}>
            <Input type="datetime-local" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} />
          </Field>
        </div>
        <Field label={refund ? 'Reason for the refund' : 'Note'} optional={!refund} required={refund} error={errors.note}>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
        </Field>
        {om && (
          <div className="flex flex-col gap-2">
            <span className="font-semibold">
              Receipt or UPI screenshot <span className="font-normal text-muted">(optional)</span>
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" icon={<Paperclip size={16} aria-hidden="true" />} onClick={() => fileRef.current?.click()}>
                {receipt ? 'Change file' : 'Attach file'}
              </Button>
              {receipt && (
                <>
                  <span className="min-w-0 truncate text-sm">{receipt.name}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setReceipt(null);
                      setReceiptDocId(null);
                    }}
                  >
                    Remove
                  </Button>
                </>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*,application/pdf"
              hidden
              onChange={(e) => {
                setReceipt(e.currentTarget.files?.[0] ?? null);
                setReceiptDocId(null);
                e.currentTarget.value = '';
              }}
            />
          </div>
        )}
        {errors.submit && <Alert>{errors.submit}</Alert>}
      </div>
      {inDialog ? <DialogFooter>{buttons}</DialogFooter> : <div className="mt-4 flex flex-wrap justify-end gap-3">{buttons}</div>}
    </>
  );
}

export function RecordPaymentDialog({
  open,
  onClose,
  booking,
  initialType,
}: {
  open: boolean;
  onClose: () => void;
  booking: BookingWithRefs;
  initialType?: PaymentType;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onClose={onClose} locked={busy} size="md" title="Record payment" description={`${booking.booking_code} · total ${formatRupees(booking.total_paise)}`}>
      <PaymentForm booking={booking} initialType={initialType} inDialog onDone={onClose} onCancel={onClose} onBusyChange={setBusy} />
    </Dialog>
  );
}

const TYPE_TONE: Record<PaymentType, 'green' | 'blue' | 'amber' | 'grey'> = {
  rent: 'green',
  extra: 'green',
  deposit: 'blue',
  refund: 'amber',
  deposit_refund: 'amber',
};

export function PaymentsCard({ booking, onRecord }: { booking: BookingWithRefs; onRecord: () => void }) {
  const payments = usePayments(booking.id);
  const staffName = useStaffName();
  const rows = payments.data ?? [];
  return (
    <Card>
      <CardHeader
        title="Payments"
        description="Rent, deposits and refunds recorded for this booking."
        actions={
          <Button size="sm" icon={<Plus size={16} aria-hidden="true" />} onClick={onRecord}>
            Record payment
          </Button>
        }
      />
      {payments.isLoading ? (
        <div className="flex justify-center p-5">
          <Spinner label="Loading payments" />
        </div>
      ) : payments.error ? (
        <p className="m-0 p-5 text-danger">{errorMessage(payments.error)}</p>
      ) : rows.length === 0 ? (
        <div className="p-4 sm:p-5">
          <EmptyState title="No payments yet" />
        </div>
      ) : (
        <ul className="m-0 list-none p-0">
          {rows.map((p) => (
            <PaymentRow key={p.id} p={p} by={staffName(p.received_by)} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function PaymentRow({ p, by }: { p: Payment; by: string }) {
  const out = isRefund(p.type);
  return (
    <li className="flex flex-col gap-1 border-b border-line-card px-4 py-3 last:border-0 sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone={TYPE_TONE[p.type]}>{PAYMENT_TYPE_LABELS[p.type]}</Badge>
          <span className="font-semibold">{PAYMENT_METHOD_LABELS[p.method]}</span>
          {p.reference && <span className="text-sm text-muted">Ref {p.reference}</span>}
          {p.receipt_document_id && (
            <span className="inline-flex items-center gap-1 text-sm text-muted">
              <Receipt size={14} aria-hidden="true" /> Receipt saved
            </span>
          )}
        </span>
        <span className={out ? 'font-bold text-danger' : 'font-bold'}>
          {out ? '− ' : ''}
          {formatRupees(p.amount_paise)}
          {out && <span className="sr-only"> paid out</span>}
        </span>
      </div>
      {p.note && <p className="m-0 text-[15px]">{p.note}</p>}
      <p className="m-0 text-sm text-muted">
        {by}, {formatDateTime(p.received_at)}
      </p>
    </li>
  );
}
