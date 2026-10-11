// Customer detail: data rights (CUS-06, DP-05) and merging duplicate records (CUS-05).
import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { Download, Eraser, GitMerge } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { IDENTITY_METHOD_LABELS } from '@shared/constants.ts';
import { Badge } from '@/components/ui/Badges';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogFooter } from '@/components/ui/Dialog';
import { Alert, Field, Textarea } from '@/components/ui/Field';
import { Card, CardBody, CardHeader } from '@/components/ui/Layout';
import { Spinner } from '@/components/ui/Spinner';
import { api } from '@/integrations/api/client';
import { errorMessage, unwrap } from '@/lib/errors';
import { formatDate, formatIsoDate, formatPhone, pluralize } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { Customer } from '@/types/db';
import { useAuth } from '../../auth/AuthProvider';
import { qk } from '../../hooks/queries';
import { useBookingCounts } from './customerData';
import { CustomerPicker } from './CustomerPicker';
import { maskedAadhaar } from './customerSearch';

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function DataRightsCard({ customer }: { customer: Customer }) {
  const { role } = useAuth();
  const [exporting, setExporting] = useState(false);
  const [erasing, setErasing] = useState(false);
  const [merging, setMerging] = useState(false);
  const erased = Boolean(customer.erased_at);

  async function exportData() {
    setExporting(true);
    try {
      const data = unwrap(await api.rpc('export_customer_data', { p_customer: customer.id }));
      downloadJson(`customer-${customer.id}.json`, data);
      toast.success('Export downloaded. It was recorded in the audit log.');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setExporting(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Data rights"
        description={
          <>
            Act on a customer&apos;s privacy request, then record it in <Link to="/admin/requests">Privacy requests</Link>.
          </>
        }
      />
      <CardBody>
        <ul className="m-0 flex list-none flex-col divide-y divide-line-card p-0">
          <Action
            title="Export data"
            text="Download what we hold about this customer as a JSON file: details, bookings, payments, the list of documents and consents. Files and document numbers are not included. Each export is logged."
            button={
              <Button variant="secondary" size="sm" icon={<Download size={16} aria-hidden="true" />} onClick={exportData} loading={exporting}>
                Export data
              </Button>
            }
          />
          {!erased && (
            <Action
              title="Erase data"
              text={
                role === 'owner'
                  ? 'Remove name, mobile, email, licence and identity details once nothing is open. Bookings and payments stay for accounts, but are no longer linked to a name.'
                  : 'Only the Owner can erase customer data. Ask them if the customer has requested erasure.'
              }
              button={
                role === 'owner' && (
                  <Button variant="danger" size="sm" icon={<Eraser size={16} aria-hidden="true" />} onClick={() => setErasing(true)}>
                    Erase data
                  </Button>
                )
              }
            />
          )}
          {!erased && role === 'owner' && (
            <Action
              title="Merge records"
              text="One person with two records, for example after a new mobile number? Merge them: bookings, documents and consents move to the record you keep."
              button={
                <Button variant="secondary" size="sm" icon={<GitMerge size={16} aria-hidden="true" />} onClick={() => setMerging(true)}>
                  Merge records
                </Button>
              }
            />
          )}
        </ul>
      </CardBody>
      {role === 'owner' && (
        <>
          <EraseDialog open={erasing} onClose={() => setErasing(false)} customer={customer} />
          <MergeDialog open={merging} onClose={() => setMerging(false)} customer={customer} />
        </>
      )}
    </Card>
  );
}

function Action({ title, text, button }: { title: string; text: string; button: ReactNode }) {
  return (
    <li className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="m-0 font-semibold">{title}</p>
        <p className="m-0 mt-0.5 text-sm text-muted">{text}</p>
      </div>
      {button && <div className="shrink-0">{button}</div>}
    </li>
  );
}

// ------------------------------------------------------------------ erase (DP-05)

function EraseDialog({ open, onClose, customer }: { open: boolean; onClose: () => void; customer: Customer }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onClose={onClose} locked={busy} size="sm" title="Erase customer data" description={customer.full_name}>
      <EraseBody customer={customer} onClose={onClose} busy={busy} setBusy={setBusy} />
    </Dialog>
  );
}

function EraseBody({ customer, onClose, busy, setBusy }: { customer: Customer; onClose: () => void; busy: boolean; setBusy: (b: boolean) => void }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const blockers = useQuery({
    queryKey: [...qk.customer(customer.id), 'erasure-blockers'],
    queryFn: async () => (unwrap(await api.rpc('erasure_blockers', { p_customer: customer.id })) ?? []) as string[],
    staleTime: 0,
    gcTime: 0,
  });

  async function erase() {
    if (!reason.trim()) return setError('Give a reason, for example the date of the customer’s request.');
    setError(null);
    setBusy(true);
    try {
      const res = unwrap(await api.rpc('erase_customer', { p_customer: customer.id, p_reason: reason.trim() })) as {
        documents_queued?: number;
      } | null;
      const files = res?.documents_queued ?? 0;
      toast.success(files > 0 ? `Customer data erased. ${pluralize(files, 'file')} will be erased tonight.` : 'Customer data erased');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.customers }),
        queryClient.invalidateQueries({ queryKey: qk.documents }),
        queryClient.invalidateQueries({ queryKey: qk.bookings }),
      ]);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (blockers.isLoading) {
    return (
      <div className="flex items-center gap-3 py-6 text-muted" role="status">
        <Spinner /> Checking for open bookings, payments and holds…
      </div>
    );
  }

  const list = blockers.data ?? [];
  const blocked = list.length > 0;

  return (
    <>
      <div className="flex flex-col gap-4">
        {blockers.error ? (
          <Alert>{errorMessage(blockers.error)}</Alert>
        ) : blocked ? (
          <Alert tone="warning" title="Erasure has to wait">
            <ul className="m-0 mt-1 pl-5">
              {list.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
            <p className="m-0 mt-2">Tell the customer why, and erase their data once these are resolved.</p>
          </Alert>
        ) : (
          <>
            <ul className="m-0 flex flex-col gap-1.5 pl-5 text-[15px]">
              <li>Name, mobile, email, licence and identity details are removed now.</li>
              <li>Bookings and payments stay for accounts, but are no longer linked to a name.</li>
              <li>Licence and ID files, signatures and handover photos are erased by the nightly job.</li>
              <li>This can&apos;t be undone.</li>
            </ul>
            <Field label="Reason" required error={error} hint="For example: erasure request received by email on 12 Oct.">
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
            </Field>
          </>
        )}
      </div>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          {blocked || blockers.error ? 'Close' : 'Cancel'}
        </Button>
        {!blocked && !blockers.error && (
          <Button variant="danger" onClick={erase} loading={busy}>
            Erase data
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

// ------------------------------------------------------------------ merge (CUS-05)

function MergeDialog({ open, onClose, customer }: { open: boolean; onClose: () => void; customer: Customer }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      locked={busy}
      size="lg"
      title="Merge customer records"
      description="Use this when one person has two records, for example after changing their mobile number."
    >
      <MergeBody customer={customer} onClose={onClose} busy={busy} setBusy={setBusy} />
    </Dialog>
  );
}

function MergeBody({ customer, onClose, busy, setBusy }: { customer: Customer; onClose: () => void; busy: boolean; setBusy: (b: boolean) => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [other, setOther] = useState<Customer | null>(null);
  const [keepId, setKeepId] = useState(customer.id);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const counts = useBookingCounts(other ? [customer.id, other.id] : []);

  async function merge() {
    if (!other) return setError('Find the other record first.');
    if (!reason.trim()) return setError('Give a reason, for example “Customer changed mobile number”.');
    setError(null);
    setBusy(true);
    const mergeId = keepId === customer.id ? other.id : customer.id;
    try {
      unwrap(await api.rpc('merge_customers', { p_keep: keepId, p_merge: mergeId, p_reason: reason.trim() }));
      toast.success('Records merged');
      onClose();
      if (keepId !== customer.id) navigate(`/admin/customers/${keepId}`, { replace: true });
      await Promise.all(
        [qk.customers, qk.bookings, qk.documents, qk.payments, qk.dataRequests].map((key) => queryClient.invalidateQueries({ queryKey: key })),
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex flex-col gap-5">
        <CustomerPicker
          label="Other record"
          value={other}
          onChange={(c) => {
            setOther(c);
            setKeepId(customer.id);
          }}
          excludeId={customer.id}
          hint="Search by the other record's mobile number or name."
        />
        {other && (
          <>
            <fieldset className="m-0 border-0 p-0">
              <legend className="mb-2 font-semibold">Which record do you want to keep?</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {[customer, other].map((c) => (
                  <div
                    key={c.id}
                    className={cn('flex flex-col gap-3 rounded-xl border bg-white p-4', keepId === c.id ? 'border-ink ring-2 ring-ink' : 'border-line-input')}
                  >
                    <label className="flex min-h-11 cursor-pointer items-center gap-3">
                      <input type="radio" name="keep" checked={keepId === c.id} onChange={() => setKeepId(c.id)} className="size-5 accent-ink" />
                      <span className="font-semibold">
                        Keep this record
                        <span className="sr-only">
                          : {c.full_name}, {formatPhone(c.phone) || 'no mobile'}
                        </span>
                      </span>
                    </label>
                    <CompareDetails customer={c} bookings={counts.data?.get(c.id)} current={c.id === customer.id} kept={keepId === c.id} />
                  </div>
                ))}
              </div>
            </fieldset>
            <Alert tone="info">
              Bookings, documents, consents and privacy requests move to the record you keep. Empty details on it (email, licence, Aadhaar last 4
              digits) are filled from the other record and notes are combined. The other record is then deleted. This can&apos;t be undone.
            </Alert>
            <Field label="Reason" required>
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
            </Field>
          </>
        )}
        {error && <Alert>{error}</Alert>}
      </div>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={merge} loading={busy} disabled={!other}>
          Merge records
        </Button>
      </DialogFooter>
    </>
  );
}

function CompareDetails({ customer: c, bookings, current, kept }: { customer: Customer; bookings: number | undefined; current: boolean; kept: boolean }) {
  const rows: Array<[string, ReactNode]> = [
    ['Name', c.full_name],
    ['Mobile', formatPhone(c.phone) || '—'],
    ['Email', c.email || '—'],
    ['Licence', c.dl_number ? <span className="font-mono">{c.dl_number}</span> : '—'],
    ['Licence valid till', c.dl_expiry ? formatIsoDate(c.dl_expiry) : '—'],
    ['Aadhaar', maskedAadhaar(c.aadhaar_last4) ?? '—'],
    ['Identity', c.identity_verified && c.identity_method ? IDENTITY_METHOD_LABELS[c.identity_method] : 'Not verified'],
    ['Bookings', bookings === undefined ? '…' : String(bookings)],
    ['Customer since', formatDate(c.created_at)],
  ];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1">
        {current && <Badge tone="outline">Open now</Badge>}
        {kept ? <Badge tone="green">Kept</Badge> : <Badge tone="grey">Merged, then deleted</Badge>}
        {c.blocked && <Badge tone="red">Blocked</Badge>}
      </div>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[15px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="m-0 min-w-0 break-words font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
