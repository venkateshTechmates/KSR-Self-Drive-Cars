// DOC-08 document verification and AAD-02/AAD-04 identity verification.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  IDENTITY_METHOD_LABELS,
  IDENTITY_METHODS,
  VERIFICATION_METHOD_LABELS,
  VERIFICATION_METHODS,
  type IdentityMethod,
  type VerificationMethod,
} from '@shared/constants.ts';
import { looksLikeFullAadhaar } from '@shared/validation.ts';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogFooter } from '@/components/ui/Dialog';
import { Alert, Checkbox, Field, Input, Select, Textarea } from '@/components/ui/Field';
import { api } from '@/integrations/api/client';
import { errorMessage, unwrap } from '@/lib/errors';
import type { DocumentRow } from '@/types/db';
import { qk } from '../../hooks/queries';

export function VerifyDocumentDialog({ doc, label, open, onClose }: { doc: DocumentRow | null; label: string; open: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open && Boolean(doc)}
      onClose={onClose}
      locked={busy}
      size="sm"
      title={`Verify: ${label}`}
      description="Compare the upload with the original document in front of you."
    >
      {doc && <VerifyDocumentBody doc={doc} onClose={onClose} busy={busy} setBusy={setBusy} />}
    </Dialog>
  );
}

function VerifyDocumentBody({ doc, onClose, busy, setBusy }: { doc: DocumentRow; onClose: () => void; busy: boolean; setBusy: (b: boolean) => void }) {
  const queryClient = useQueryClient();
  const [decision, setDecision] = useState<'verified' | 'rejected'>('verified');
  const [method, setMethod] = useState<VerificationMethod>('original_seen');
  const [expiry, setExpiry] = useState(doc.expiry_date ?? '');
  const [number, setNumber] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const isDl = doc.doc_type === 'dl_front';

  async function save() {
    setError(null);
    if (decision === 'verified' && isDl && !expiry) return setError('Enter the licence expiry date.');
    if (decision === 'rejected' && !reason.trim()) return setError('Give a reason for rejecting it.');
    if (number && looksLikeFullAadhaar(number)) return setError("Don't enter a full Aadhaar number.");
    setBusy(true);
    try {
      unwrap(
        await api.rpc('verify_document', {
          p_doc: doc.id,
          p_status: decision,
          p_method: decision === 'verified' ? method : null,
          p_reason: decision === 'rejected' ? reason.trim() : null,
          p_expiry_date: expiry || null,
          p_doc_number: number.trim() || null,
        }),
      );
      toast.success(decision === 'verified' ? 'Marked verified' : 'Marked rejected');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.documents }),
        queryClient.invalidateQueries({ queryKey: qk.customers }),
        queryClient.invalidateQueries({ queryKey: qk.bookings }),
      ]);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex flex-col gap-4">
        <fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0">
          <legend className="mb-2 font-semibold">Result</legend>
          {(['verified', 'rejected'] as const).map((d) => (
            <label key={d} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-line-input bg-white px-4">
              <input type="radio" name="decision" checked={decision === d} onChange={() => setDecision(d)} className="size-4 accent-ink" />
              {d === 'verified' ? 'Verified' : 'Rejected'}
            </label>
          ))}
        </fieldset>
        {decision === 'verified' ? (
          <>
            <Field label="How did you check it?">
              <Select value={method} onChange={(e) => setMethod(e.target.value as VerificationMethod)}>
                {VERIFICATION_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {VERIFICATION_METHOD_LABELS[m]}
                  </option>
                ))}
              </Select>
            </Field>
            {(isDl || doc.expiry_date !== null) && (
              <Field label="Expiry date" required={isDl} hint={isDl ? 'Valid-till date printed on the licence.' : undefined}>
                <Input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
              </Field>
            )}
            {isDl && (
              <Field label="Licence number" optional hint="Updates the number on the customer record.">
                <Input value={number} onChange={(e) => setNumber(e.target.value.toUpperCase())} autoComplete="off" />
              </Field>
            )}
          </>
        ) : (
          <Field label="Reason" required>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
          </Field>
        )}
        {error && <Alert>{error}</Alert>}
      </div>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant={decision === 'rejected' ? 'danger' : 'primary'} onClick={save} loading={busy}>
          {decision === 'verified' ? 'Mark verified' : 'Mark rejected'}
        </Button>
      </DialogFooter>
    </>
  );
}

const AADHAAR_METHODS: IdentityMethod[] = ['aadhaar_qr', 'aadhaar_original_seen'];

export function VerifyIdentityDialog({
  customerId,
  bookingId,
  open,
  onClose,
}: {
  customerId: string;
  bookingId?: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onClose={onClose} locked={busy} size="sm" title="Verify identity">
      <VerifyIdentityBody customerId={customerId} bookingId={bookingId} onClose={onClose} busy={busy} setBusy={setBusy} />
    </Dialog>
  );
}

function VerifyIdentityBody({
  customerId,
  bookingId,
  onClose,
  busy,
  setBusy,
}: {
  customerId: string;
  bookingId?: string | null;
  onClose: () => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [method, setMethod] = useState<IdentityMethod>('aadhaar_qr');
  const [last4, setLast4] = useState('');
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isAadhaar = AADHAAR_METHODS.includes(method);

  async function save() {
    setError(null);
    if (isAadhaar && !/^\d{4}$/.test(last4)) return setError('Enter the last 4 digits of the Aadhaar number.');
    if (isAadhaar && !consent) return setError('Ask the customer first and tick the consent box.');
    setBusy(true);
    try {
      unwrap(
        await api.rpc('verify_customer_identity', {
          p_customer: customerId,
          p_method: method,
          p_aadhaar_last4: isAadhaar ? last4 : null,
          p_consent: isAadhaar ? consent : false,
          p_booking: bookingId ?? null,
        }),
      );
      toast.success('Identity verified');
      await Promise.all([queryClient.invalidateQueries({ queryKey: qk.customers }), queryClient.invalidateQueries({ queryKey: qk.bookings })]);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex flex-col gap-4">
        <Field label="Method">
          <Select value={method} onChange={(e) => setMethod(e.target.value as IdentityMethod)}>
            {IDENTITY_METHODS.filter((m) => m !== 'digilocker').map((m) => (
              <option key={m} value={m}>
                {IDENTITY_METHOD_LABELS[m]}
              </option>
            ))}
          </Select>
        </Field>
        {method === 'aadhaar_qr' && (
          <Alert tone="info">
            Scan the secure QR code on the customer&apos;s Aadhaar (card, e-Aadhaar, m-Aadhaar or PVC card) with UIDAI&apos;s official app and
            check the photo and name match. Never write down or photograph the full number.
          </Alert>
        )}
        {isAadhaar && (
          <>
            <Field label="Last 4 digits of Aadhaar" hint="Only the last 4 digits are kept, for matching.">
              <Input
                inputMode="numeric"
                maxLength={4}
                value={last4}
                onChange={(e) => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))}
                autoComplete="off"
              />
            </Field>
            <Checkbox
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              label="The customer agreed to Aadhaar verification for this rental."
              description="Customers may show a passport or voter ID instead. Don't refuse service if they prefer another ID."
            />
          </>
        )}
        {error && <Alert>{error}</Alert>}
      </div>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={save} loading={busy}>
          Save
        </Button>
      </DialogFooter>
    </>
  );
}
