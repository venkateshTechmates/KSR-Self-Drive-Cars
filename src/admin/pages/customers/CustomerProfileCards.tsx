// Customer detail: contact and licence, identity verification (AAD-02..04) and blocklist (CUS-03, CUS-04).
import { useState } from 'react';
import { Ban, Pencil, ShieldCheck, ShieldOff } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { IDENTITY_METHOD_LABELS } from '@shared/constants.ts';
import { expiryState } from '@shared/documents.ts';
import { checkDl, looksLikeFullAadhaar, normalizeDl, normalizeName, validateEmail, validateName } from '@shared/validation.ts';
import { Badge, ExpiryPill } from '@/components/ui/Badges';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog, Dialog, DialogFooter } from '@/components/ui/Dialog';
import { Alert, Field, Input, Textarea } from '@/components/ui/Field';
import { Card, CardBody, CardHeader, KeyValue } from '@/components/ui/Layout';
import { api } from '@/integrations/api/client';
import { errorMessage, unwrap } from '@/lib/errors';
import { formatDate, formatDateTime, formatIsoDate, formatPhone, istDateIso, telHref } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import type { Customer } from '@/types/db';
import { VerifyIdentityDialog } from '../../components/documents/VerifyDialogs';
import { qk, useStaffName } from '../../hooks/queries';
import { containsFullAadhaar, maskedAadhaar } from './customerSearch';

// ------------------------------------------------------------------ contact and licence

export function ContactCard({ customer, readOnly }: { customer: Customer; readOnly?: boolean }) {
  const now = useNow();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const expiry = expiryState(customer.dl_expiry, istDateIso(now));

  return (
    <Card>
      <CardHeader
        title="Contact and licence"
        actions={
          !readOnly && (
            <Button variant="secondary" size="sm" icon={<Pencil size={16} aria-hidden="true" />} onClick={() => setEditing(true)}>
              Edit
            </Button>
          )
        }
      />
      <CardBody>
        <KeyValue
          items={[
            [
              'Mobile',
              customer.phone ? (
                <a href={telHref(customer.phone)} className="text-ink">
                  {formatPhone(customer.phone)}
                </a>
              ) : null,
            ],
            ['Email', customer.email ? <a href={`mailto:${customer.email}`}>{customer.email}</a> : null],
            ['Licence number', customer.dl_number ? <span className="font-mono">{customer.dl_number}</span> : null],
            [
              'Licence valid till',
              customer.dl_expiry ? (
                <span className="inline-flex flex-wrap items-center gap-2">
                  {formatIsoDate(customer.dl_expiry)}
                  <ExpiryPill state={expiry} />
                </span>
              ) : null,
            ],
            ['Customer since', formatDate(customer.created_at)],
          ]}
        />
        <div className="mt-4 border-t border-line-card pt-3">
          <p className="m-0 text-sm text-muted">Notes</p>
          <p className="m-0 whitespace-pre-wrap">{customer.notes || <span className="text-muted">No notes</span>}</p>
        </div>
      </CardBody>
      <Dialog open={editing} onClose={() => setEditing(false)} locked={busy} title="Edit customer details">
        <EditCustomerForm key={customer.id} customer={customer} onClose={() => setEditing(false)} busy={busy} setBusy={setBusy} />
      </Dialog>
    </Card>
  );
}

type EditField = 'name' | 'email' | 'dl' | 'dlExpiry' | 'notes' | 'form';

function EditCustomerForm({
  customer,
  onClose,
  busy,
  setBusy,
}: {
  customer: Customer;
  onClose: () => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(customer.full_name);
  const [email, setEmail] = useState(customer.email ?? '');
  const [dl, setDl] = useState(customer.dl_number ?? '');
  const [dlExpiry, setDlExpiry] = useState(customer.dl_expiry ?? '');
  const [notes, setNotes] = useState(customer.notes);
  const [errors, setErrors] = useState<Partial<Record<EditField, string>>>({});
  const dlCheck = dl.trim() ? checkDl(dl) : null;

  async function save() {
    const next: Partial<Record<EditField, string>> = {};
    if (validateName(name)) next.name = 'Enter a name of 2–80 letters. Spaces, full stops, apostrophes and hyphens are fine.';
    const emailError = validateEmail(email);
    if (emailError) next.email = emailError;
    if (dl.trim()) {
      if (looksLikeFullAadhaar(dl)) next.dl = "That looks like an Aadhaar number. Enter the driving licence number; Aadhaar numbers are never stored.";
      else if (dlCheck?.error) next.dl = 'Enter the licence number as printed, for example TS0920110012345.';
    }
    if (containsFullAadhaar(notes)) next.notes = "Notes can't include a full Aadhaar number. Remove it; only the last 4 digits may be kept.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setBusy(true);
    try {
      unwrap(
        await api
          .from('customers')
          .update({
            full_name: normalizeName(name),
            email: email.trim() ? email.trim().toLowerCase() : null,
            dl_number: dl.trim() ? normalizeDl(dl) : null,
            dl_expiry: dlExpiry || null,
            notes: notes.trim(),
          })
          .eq('id', customer.id)
          .select('id')
          .single(),
      );
      toast.success('Details saved');
      await queryClient.invalidateQueries({ queryKey: qk.customers });
      onClose();
    } catch (err) {
      setErrors({ form: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex flex-col gap-4">
        <Field label="Full name" required error={errors.name}>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={80} />
        </Field>
        <Field label="Mobile" hint="To change the mobile number, book with the new number and ask the Owner to merge the two records.">
          <Input value={formatPhone(customer.phone)} readOnly disabled />
        </Field>
        <Field label="Email" optional error={errors.email}>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
        </Field>
        <Field
          label="Driving licence number"
          optional
          error={errors.dl}
          hint={!errors.dl && dlCheck?.oldFormat ? "This doesn't match the current licence format. You can still save it; check it against the licence." : undefined}
        >
          <Input value={dl} onChange={(e) => setDl(e.target.value.toUpperCase())} autoComplete="off" spellCheck={false} maxLength={24} />
        </Field>
        <Field label="Licence valid till" optional error={errors.dlExpiry}>
          <Input type="date" value={dlExpiry} onChange={(e) => setDlExpiry(e.target.value)} />
        </Field>
        <Field label="Notes" optional error={errors.notes} hint="Only staff see notes. Notes are not included in the customer's data export.">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} />
        </Field>
        {errors.form && <Alert>{errors.form}</Alert>}
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

// ------------------------------------------------------------------ identity

export function IdentityCard({ customer, readOnly }: { customer: Customer; readOnly?: boolean }) {
  const queryClient = useQueryClient();
  const staffName = useStaffName();
  const [verifying, setVerifying] = useState(false);
  const [clearing, setClearing] = useState(false);
  const method = customer.identity_method ? IDENTITY_METHOD_LABELS[customer.identity_method] : null;

  return (
    <Card>
      <CardHeader
        title="Identity"
        actions={
          !readOnly &&
          (customer.identity_verified ? (
            <Button variant="secondary" size="sm" icon={<ShieldOff size={16} aria-hidden="true" />} onClick={() => setClearing(true)}>
              Clear verification
            </Button>
          ) : (
            <Button size="sm" icon={<ShieldCheck size={16} aria-hidden="true" />} onClick={() => setVerifying(true)}>
              Verify identity
            </Button>
          ))
        }
      />
      <CardBody>
        <KeyValue
          items={[
            ['Status', customer.identity_verified ? <Badge tone="green">Verified</Badge> : <Badge tone="amber">Not verified</Badge>],
            customer.identity_verified && ['Method', method],
            customer.identity_verified && ['Verified by', staffName(customer.identity_verified_by)],
            customer.identity_verified && ['Verified on', customer.identity_verified_at ? formatDateTime(customer.identity_verified_at) : null],
            ['Aadhaar', maskedAadhaar(customer.aadhaar_last4) ?? <span className="font-normal text-muted">Not recorded</span>],
          ]}
        />
        {!customer.identity_verified && !readOnly && (
          <p className="m-0 mt-4 text-sm text-muted">
            Verify at pickup by scanning the Aadhaar secure QR with UIDAI&apos;s app, or check a passport or voter ID. Only the last 4 Aadhaar digits
            are kept.
          </p>
        )}
      </CardBody>
      <VerifyIdentityDialog customerId={customer.id} open={verifying} onClose={() => setVerifying(false)} />
      <ConfirmDialog
        open={clearing}
        onClose={() => setClearing(false)}
        title="Clear identity verification?"
        description="The customer will need to be verified again before their next pickup."
        confirmLabel="Clear verification"
        tone="danger"
        reasonLabel="Reason"
        reasonHint="For example: verified against the wrong ID."
        onConfirm={async (reason) => {
          unwrap(await api.rpc('clear_customer_identity', { p_customer: customer.id, p_reason: reason }));
          toast.success('Verification cleared');
          await Promise.all([queryClient.invalidateQueries({ queryKey: qk.customers }), queryClient.invalidateQueries({ queryKey: qk.bookings })]);
        }}
      />
    </Card>
  );
}

// ------------------------------------------------------------------ blocklist

export function BlocklistCard({ customer, readOnly }: { customer: Customer; readOnly?: boolean }) {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<'block' | 'unblock' | null>(null);

  async function setBlocked(blocked: boolean, reason: string | null) {
    unwrap(await api.rpc('set_customer_block', { p_customer: customer.id, p_blocked: blocked, p_reason: reason }));
    toast.success(blocked ? 'Customer blocked' : 'Customer unblocked');
    await Promise.all([queryClient.invalidateQueries({ queryKey: qk.customers }), queryClient.invalidateQueries({ queryKey: qk.bookings })]);
  }

  return (
    <Card>
      <CardHeader
        title="Blocklist"
        actions={
          !readOnly &&
          (customer.blocked ? (
            <Button variant="secondary" size="sm" onClick={() => setDialog('unblock')}>
              Unblock
            </Button>
          ) : (
            <Button variant="secondary" size="sm" icon={<Ban size={16} aria-hidden="true" />} onClick={() => setDialog('block')}>
              Block customer
            </Button>
          ))
        }
      />
      <CardBody>
        {customer.blocked ? (
          <div className="flex flex-col gap-2">
            <p className="m-0">
              <Badge tone="red">Blocked</Badge>
            </p>
            <p className="m-0">
              <span className="text-muted">Reason: </span>
              <span className="font-semibold">{customer.block_reason}</span>
            </p>
            <p className="m-0 text-sm text-muted">New booking requests from this mobile number are flagged for review.</p>
          </div>
        ) : (
          <p className="m-0 text-muted">
            Not blocked. Block a customer to flag new booking requests from their mobile number, for example after unpaid damage.
          </p>
        )}
      </CardBody>
      <ConfirmDialog
        open={dialog === 'block'}
        onClose={() => setDialog(null)}
        title="Block this customer?"
        description="New requests from this mobile number are flagged for review. Existing bookings don't change."
        confirmLabel="Block customer"
        tone="danger"
        reasonLabel="Reason"
        reasonHint="Staff see this when the customer books again. For example: unpaid damage from booking KSR-261012-004."
        onConfirm={(reason) => setBlocked(true, reason)}
      />
      <ConfirmDialog
        open={dialog === 'unblock'}
        onClose={() => setDialog(null)}
        title="Unblock this customer?"
        description="New requests from this mobile number will no longer be flagged."
        confirmLabel="Unblock"
        onConfirm={() => setBlocked(false, null)}
      />
    </Card>
  );
}
