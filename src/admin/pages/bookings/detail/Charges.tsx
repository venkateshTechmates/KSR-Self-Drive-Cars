// HND-04: extra charges (late return, fuel, damage, cleaning, challans) as line items.
import { useRef, useState, type ReactNode } from 'react';
import { Paperclip, Plus, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { CHARGE_KIND_LABELS, type ChargeKind } from '@shared/constants.ts';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog, Dialog, DialogFooter } from '@/components/ui/Dialog';
import { Alert, Field, Select, Textarea } from '@/components/ui/Field';
import { Card, CardHeader } from '@/components/ui/Layout';
import { Spinner } from '@/components/ui/Spinner';
import { uploadDocument } from '@/lib/documents';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatRupees, parseRupees } from '@/lib/format';
import type { BookingCharge, BookingWithRefs } from '@/types/db';
import { isOwnerOrManager, useAuth } from '@/admin/auth/AuthProvider';
import { useStaffName } from '@/admin/hooks/queries';
import { rpc, useCharges, useRefresh } from './api';
import { canAddCharge } from './helpers';
import { MoneyInput } from './ui';

/** Kinds staff add by hand. Extensions are added by extend_booking. */
const MANUAL_CHARGE_KINDS: ChargeKind[] = ['late', 'fuel', 'damage', 'cleaning', 'challan', 'other'];
const NOTE_REQUIRED: ChargeKind[] = ['damage', 'challan', 'other'];

export function ChargeForm({
  booking,
  initialKind = 'damage',
  inDialog,
  onDone,
  onCancel,
  onBusyChange,
}: {
  booking: BookingWithRefs;
  initialKind?: ChargeKind;
  inDialog?: boolean;
  onDone: () => void;
  onCancel?: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { role } = useAuth();
  const om = isOwnerOrManager(role);
  const refresh = useRefresh();
  const [kind, setKind] = useState<ChargeKind>(initialKind);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  /** File already saved by an earlier attempt; uploading the same file again is refused as a duplicate. */
  const [fileDocId, setFileDocId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusyState] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const noteRequired = NOTE_REQUIRED.includes(kind);

  const setBusy = (b: boolean) => {
    setBusyState(b);
    onBusyChange?.(b);
  };

  async function submit() {
    const e: Record<string, string> = {};
    const paise = parseRupees(amount);
    if (paise === null || paise <= 0) e.amount = 'Enter an amount above zero, for example 500.';
    if (noteRequired && !note.trim()) e.note = 'Describe the charge, for example "Scratch on rear bumper".';
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      let documentId = fileDocId;
      if (!documentId && file) {
        const res = await uploadDocument({
          ownerType: 'booking',
          ownerId: booking.id,
          docType: kind === 'challan' ? 'challan' : 'damage_photos',
          file,
          notes: `${CHARGE_KIND_LABELS[kind]}: ${note.trim()}`.slice(0, 500),
        });
        documentId = res.document.id;
        setFileDocId(documentId);
      }
      await rpc('add_booking_charge', {
        p_booking: booking.id,
        p_kind: kind,
        p_amount_paise: paise,
        p_note: note.trim(),
        p_document_id: documentId,
      });
      toast.success(`${CHARGE_KIND_LABELS[kind]} charge of ${formatRupees(paise)} added`);
      await refresh('documents');
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
      <Button onClick={submit} loading={busy} loadingText="Adding…">
        Add charge
      </Button>
    </>
  );

  return (
    <>
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Charge for">
            <Select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as ChargeKind);
                // The file is saved under a type that depends on the kind (challan or damage photo).
                setFileDocId(null);
              }}
            >
              {MANUAL_CHARGE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {CHARGE_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Amount" error={errors.amount}>
            <MoneyInput value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
        </div>
        <Field label="Note" required={noteRequired} optional={!noteRequired} error={errors.note}>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
        </Field>
        {om && (
          <div className="flex flex-col gap-2">
            <span className="font-semibold">
              {kind === 'challan' ? 'Challan or fine notice' : 'Photo or repair estimate'} <span className="font-normal text-muted">(optional)</span>
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" icon={<Paperclip size={16} aria-hidden="true" />} onClick={() => fileRef.current?.click()}>
                {file ? 'Change file' : 'Attach photo or file'}
              </Button>
              {file && (
                <>
                  <span className="min-w-0 truncate text-sm">{file.name}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setFile(null);
                      setFileDocId(null);
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
                setFile(e.currentTarget.files?.[0] ?? null);
                setFileDocId(null);
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

export function AddChargeDialog({ open, onClose, booking }: { open: boolean; onClose: () => void; booking: BookingWithRefs }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onClose={onClose} locked={busy} size="md" title="Add a charge" description="Charges are added to the total due.">
      <ChargeForm booking={booking} inDialog onDone={onClose} onCancel={onClose} onBusyChange={setBusy} />
    </Dialog>
  );
}

/** Compact list of charges; Owner/Manager can remove one with a reason. */
export function ChargeList({ booking, charges }: { booking: BookingWithRefs; charges: BookingCharge[] }) {
  const { role } = useAuth();
  const om = isOwnerOrManager(role);
  const staffName = useStaffName();
  const refresh = useRefresh();
  const [removing, setRemoving] = useState<BookingCharge | null>(null);
  const total = charges.reduce((n, c) => n + c.amount_paise, 0);
  return (
    <>
      <ul className="m-0 list-none p-0">
        {charges.map((c) => (
          <li key={c.id} className="flex flex-wrap items-start justify-between gap-2 border-b border-line-card py-3 last:border-0">
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">{CHARGE_KIND_LABELS[c.kind]}</span>
              {c.note && <span className="block text-[15px]">{c.note}</span>}
              <span className="block text-sm text-muted">
                {staffName(c.added_by)}, {formatDateTime(c.created_at)}
                {c.document_id ? ' · file attached' : ''}
              </span>
            </span>
            <span className="flex items-center gap-1">
              <span className="font-bold">{formatRupees(c.amount_paise)}</span>
              {om && booking.status !== 'closed' && (
                <Button variant="ghost" size="sm" icon={<Trash2 size={16} aria-hidden="true" />} onClick={() => setRemoving(c)} aria-label={`Remove ${CHARGE_KIND_LABELS[c.kind]} charge of ${formatRupees(c.amount_paise)}`}>
                  Remove
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {charges.length > 1 && (
        <p className="m-0 flex justify-between border-t border-line-card pt-3 font-bold">
          <span>Total extras</span>
          <span>{formatRupees(total)}</span>
        </p>
      )}
      <ConfirmDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        title="Remove this charge?"
        description={removing ? `${CHARGE_KIND_LABELS[removing.kind]} ${formatRupees(removing.amount_paise)}. The total due goes down by this amount.` : undefined}
        confirmLabel="Remove charge"
        tone="danger"
        reasonLabel="Reason"
        onConfirm={async (reason) => {
          await rpc('remove_booking_charge', { p_charge: removing!.id, p_reason: reason });
          toast.success('Charge removed');
          await refresh();
        }}
      />
    </>
  );
}

export function ChargesCard({ booking, onAdd }: { booking: BookingWithRefs; onAdd: () => void }) {
  const { role } = useAuth();
  const charges = useCharges(booking.id);
  const rows = charges.data ?? [];
  const canAdd = canAddCharge(booking.status, isOwnerOrManager(role));
  return (
    <Card>
      <CardHeader
        title="Extra charges"
        description="Late return, fuel, damage, cleaning, fines and extensions."
        actions={
          canAdd && (
            <Button size="sm" variant="secondary" icon={<Plus size={16} aria-hidden="true" />} onClick={onAdd}>
              Add charge
            </Button>
          )
        }
      />
      <div className="px-4 py-2 sm:px-5">
        {charges.isLoading ? (
          <div className="flex justify-center p-4">
            <Spinner label="Loading charges" />
          </div>
        ) : charges.error ? (
          <p className="m-0 py-3 text-danger">{errorMessage(charges.error)}</p>
        ) : rows.length === 0 ? (
          <p className="m-0 py-3 text-muted">No extra charges.</p>
        ) : (
          <ChargeList booking={booking} charges={rows} />
        )}
      </div>
    </Card>
  );
}

