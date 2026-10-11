// Log a new privacy request, and update one (status, resolution, customer link).
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { DATA_REQUEST_KINDS, DATA_REQUEST_LABELS, type DataRequestKind } from '@shared/constants.ts';
import { addDaysIso, formatDateTime, istDateIso, istStartOfDay } from '@shared/time.ts';
import { formatPhone, normalizePhone, validateEmail } from '@shared/validation.ts';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogFooter } from '@/components/ui/Dialog';
import { Alert, Field, Input, Select, Textarea } from '@/components/ui/Field';
import { KeyValue } from '@/components/ui/Layout';
import { supabase } from '@/integrations/supabase/client';
import { errorMessage, unwrap } from '@/lib/errors';
import { useNow } from '@/lib/useNow';
import type { Customer } from '@/types/db';
import { useAuth } from '../../auth/AuthProvider';
import { qk } from '../../hooks/queries';
import { CustomerPicker, type PickedCustomer } from '../customers/CustomerPicker';
import { containsFullAadhaar, useDebounced } from '../customers/customerSearch';
import { DEFAULT_DUE_DAYS, endOfIstDay, isOpen, REQUEST_STATUS_LABELS, REQUEST_STATUSES, type RequestRow, type RequestStatus } from './requestData';

const AADHAAR_IN_TEXT = "Don't write a full Aadhaar number here. Keep at most the last 4 digits.";

// ------------------------------------------------------------------ new request

export function NewRequestDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      locked={busy}
      title="Log a privacy request"
      description="Record each request a customer makes about their data, by any channel, and answer it by the due date."
    >
      <NewRequestForm onClose={onClose} busy={busy} setBusy={setBusy} />
    </Dialog>
  );
}

type NewField = 'name' | 'contact' | 'details' | 'received' | 'due' | 'form';

function NewRequestForm({ onClose, busy, setBusy }: { onClose: () => void; busy: boolean; setBusy: (b: boolean) => void }) {
  const now = useNow();
  const today = istDateIso(now);
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [kind, setKind] = useState<DataRequestKind>('access');
  const [details, setDetails] = useState('');
  const [customer, setCustomer] = useState<PickedCustomer | null>(null);
  const [received, setReceived] = useState(today);
  const [due, setDue] = useState(addDaysIso(today, DEFAULT_DUE_DAYS));
  const [dueTouched, setDueTouched] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<NewField, string>>>({});

  // Suggest the customer whose mobile number matches the contact given.
  const phone = useDebounced(normalizePhone(contact), 300);
  const match = useQuery({
    queryKey: [...qk.customers, 'by-phone', phone],
    enabled: Boolean(phone) && !customer,
    queryFn: async () => unwrap(await supabase.from('customers').select('*').eq('phone', phone!).maybeSingle()) as Customer | null,
  });
  const suggestion = !customer && phone && match.data ? match.data : null;

  async function save() {
    const next: Partial<Record<NewField, string>> = {};
    if (!name.trim()) next.name = "Enter the requester's name.";
    else if (containsFullAadhaar(name)) next.name = AADHAAR_IN_TEXT;
    const contactPhone = normalizePhone(contact);
    const isEmail = contact.includes('@') && !validateEmail(contact);
    if (!contactPhone && !isEmail) next.contact = 'Enter a 10-digit mobile number or an email address.';
    if (containsFullAadhaar(details)) next.details = AADHAAR_IN_TEXT;
    if (!received || received > today) next.received = "Enter the date the request arrived. It can't be in the future.";
    if (!due) next.due = 'Enter the date the answer is due.';
    else if (received && due < received) next.due = "The due date can't be before the date received.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setBusy(true);
    try {
      unwrap(
        await supabase
          .from('data_requests')
          .insert({
            requester_name: name.trim(),
            requester_contact: contactPhone ?? contact.trim().toLowerCase(),
            kind,
            details: details.trim(),
            customer_id: customer?.id ?? null,
            status: 'open',
            received_at: received === today ? new Date().toISOString() : istStartOfDay(received).toISOString(),
            due_at: endOfIstDay(due),
            created_by: session?.user.id ?? null,
          })
          .select('id')
          .single(),
      );
      toast.success('Request logged');
      await queryClient.invalidateQueries({ queryKey: qk.dataRequests });
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
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Requester's name" required error={errors.name}>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={120} />
          </Field>
          <Field label="Mobile or email" required error={errors.contact} hint="How to reply to them.">
            <Input value={contact} onChange={(e) => setContact(e.target.value)} autoComplete="off" />
          </Field>
        </div>
        <Field label="Request">
          <Select value={kind} onChange={(e) => setKind(e.target.value as DataRequestKind)}>
            {DATA_REQUEST_KINDS.map((k) => (
              <option key={k} value={k}>
                {DATA_REQUEST_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Details" optional error={errors.details} hint="What they asked for, and how it reached us (email, phone, at the counter).">
          <Textarea value={details} onChange={(e) => setDetails(e.target.value)} rows={3} />
        </Field>

        {suggestion && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line-card bg-subtle px-4 py-3" role="status">
            <p className="m-0">
              This mobile number belongs to <span className="font-semibold">{suggestion.full_name}</span>.
            </p>
            <Button variant="secondary" size="sm" onClick={() => setCustomer(suggestion)}>
              Link this customer
            </Button>
          </div>
        )}
        <CustomerPicker
          label="Customer record"
          optional
          value={customer}
          onChange={setCustomer}
          hint="Link the customer so you can act on their record. Search by mobile or name."
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Received on" required error={errors.received}>
            <Input
              type="date"
              value={received}
              max={today}
              onChange={(e) => {
                setReceived(e.target.value);
                if (!dueTouched && e.target.value) setDue(addDaysIso(e.target.value, DEFAULT_DUE_DAYS));
              }}
            />
          </Field>
          <Field label="Answer by" required error={errors.due} hint={`Set the deadline the law requires. It starts at ${DEFAULT_DUE_DAYS} days after the request arrived.`}>
            <Input
              type="date"
              value={due}
              min={received || undefined}
              onChange={(e) => {
                setDue(e.target.value);
                setDueTouched(true);
              }}
            />
          </Field>
        </div>
        {errors.form && <Alert>{errors.form}</Alert>}
      </div>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={save} loading={busy}>
          Log request
        </Button>
      </DialogFooter>
    </>
  );
}

// ------------------------------------------------------------------ update

export function UpdateRequestDialog({ request, onClose }: { request: RequestRow | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={Boolean(request)}
      onClose={onClose}
      locked={busy}
      title="Update request"
      description={request ? `${DATA_REQUEST_LABELS[request.kind]} · ${request.requester_name}` : undefined}
    >
      {request && <UpdateRequestForm key={request.id} request={request} onClose={onClose} busy={busy} setBusy={setBusy} />}
    </Dialog>
  );
}

type UpdateField = 'resolution' | 'due' | 'form';

function UpdateRequestForm({
  request,
  onClose,
  busy,
  setBusy,
}: {
  request: RequestRow;
  onClose: () => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<RequestStatus>(request.status);
  const [resolution, setResolution] = useState(request.resolution ?? '');
  const [due, setDue] = useState(request.due_at ? istDateIso(request.due_at) : '');
  const [customer, setCustomer] = useState<PickedCustomer | null>(request.customer);
  const [errors, setErrors] = useState<Partial<Record<UpdateField, string>>>({});
  const closing = status === 'done' || status === 'refused';

  async function save() {
    const next: Partial<Record<UpdateField, string>> = {};
    if (closing && !resolution.trim())
      next.resolution = status === 'done' ? 'Say what you did, for example "Sent the export by email".' : 'Say why the request was refused.';
    if (containsFullAadhaar(resolution)) next.resolution = AADHAAR_IN_TEXT;
    if (due && due < istDateIso(request.received_at)) next.due = "The due date can't be before the date received.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    // Keep the first resolution time if it was already closed; clear it when reopened.
    const resolvedAt = closing ? (!isOpen(request) && request.resolved_at ? request.resolved_at : new Date().toISOString()) : null;
    setBusy(true);
    try {
      unwrap(
        await supabase
          .from('data_requests')
          .update({
            status,
            resolution: resolution.trim() || null,
            due_at: due ? endOfIstDay(due) : null,
            customer_id: customer?.id ?? null,
            handled_by: session?.user.id ?? request.handled_by,
            resolved_at: resolvedAt,
          })
          .eq('id', request.id)
          .select('id')
          .single(),
      );
      toast.success('Request updated');
      await queryClient.invalidateQueries({ queryKey: qk.dataRequests });
      onClose();
    } catch (err) {
      setErrors({ form: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  const contactLabel = request.requester_contact.startsWith('+91') ? formatPhone(request.requester_contact) : request.requester_contact;

  return (
    <>
      <div className="flex flex-col gap-4">
        <KeyValue
          items={[
            ['Requester', request.requester_name],
            ['Contact', contactLabel],
            ['Received', formatDateTime(request.received_at)],
            request.details ? ['Details', <span className="font-normal whitespace-pre-wrap">{request.details}</span>] : null,
          ]}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value as RequestStatus)}>
              {REQUEST_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {REQUEST_STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Answer by" error={errors.due} hint="Set the deadline the law requires.">
            <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </Field>
        </div>
        <Field
          label="Resolution notes"
          required={closing}
          optional={!closing}
          error={errors.resolution}
          hint="What was done and when the customer was told. For refusals, the reason given to them."
        >
          <Textarea value={resolution} onChange={(e) => setResolution(e.target.value)} rows={4} />
        </Field>
        <CustomerPicker label="Customer record" optional value={customer} onChange={setCustomer} hint="Search by mobile or name." />
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
