// Document types and retention (SET-06, Section 10.4). Owners edit labels, who can view and
// download, expiry tracking and retention; Staff can never download KYC documents.
import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Pencil, Plus } from 'lucide-react';
import { APP_ROLES, DOC_OWNER_LABELS, DOC_OWNER_TYPES, ROLE_LABELS, type AppRole, type DocOwnerType } from '@shared/constants.ts';
import type { RetentionSettings } from '@shared/settings.ts';
import { Badge } from '@/components/ui/Badges';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogFooter } from '@/components/ui/Dialog';
import { Alert, Checkbox, Field, Input, Select } from '@/components/ui/Field';
import { Card, CardBody, CardHeader, DataTable, type Column } from '@/components/ui/Layout';
import { api } from '@/integrations/api/client';
import { errorMessage, toAppError, unwrap } from '@/lib/errors';
import type { DocumentType } from '@/types/db';
import { qk, useDocumentTypes, useSaveSetting, useSetting } from '../../hooks/queries';
import { FormCard, Loader, SaveBar } from './FormParts';
import { Errors, parseOptionalWhole, parseWhole, sameJson } from './formUtils';

type Basis = DocumentType['retention_basis'];

const BASIS_LABELS: Record<Basis, string> = {
  none: 'No automatic erasure',
  booking_end: 'After the booking ends',
  customer_last_booking_end: "After the customer's last booking ends",
};

/** Retention bases that make sense for each owner (the purge job reads booking or customer dates). */
const BASES_FOR: Record<DocOwnerType, Basis[]> = {
  customer: ['none', 'customer_last_booking_end'],
  booking: ['none', 'booking_end'],
  car: ['none'],
  business: ['none'],
};

const KEY_RE = /^[a-z][a-z0-9_]{1,40}$/;
const rolesText = (roles: AppRole[]) => APP_ROLES.filter((r) => roles.includes(r)).map((r) => ROLE_LABELS[r]).join(', ') || '—';

function retentionText(t: Pick<DocumentType, 'retention_days' | 'retention_basis'>): string {
  if (t.retention_days === null || t.retention_basis === 'none') return 'Kept until removed';
  return `${t.retention_days} days ${t.retention_basis === 'booking_end' ? 'after booking ends' : "after customer's last booking"}`;
}

export function DocumentsTab() {
  const types = useDocumentTypes();
  const retention = useSetting('retention');
  return (
    <div className="flex flex-col gap-5">
      <Loader query={types}>{(rows) => <TypesCard rows={rows} />}</Loader>
      <Loader query={retention}>
        {(data) => (
          <RetentionForm
            key={`${retention.dataUpdatedAt}`}
            initial={data}
            longestDocDays={Math.max(0, ...(types.data ?? []).map((t) => (t.retention_basis === 'none' ? 0 : (t.retention_days ?? 0))))}
          />
        )}
      </Loader>
    </div>
  );
}

// ---------------------------------------------------------------- document types

function TypesCard({ rows }: { rows: DocumentType[] }) {
  const [editing, setEditing] = useState<DocumentType | 'new' | null>(null);

  const columns: Column<DocumentType>[] = [
    {
      key: 'label',
      header: 'Type',
      hideOnMobile: true,
      cell: (t) => (
        <>
          <span className="font-semibold">{t.label}</span>
          <span className="block font-mono text-[13px] text-muted">{t.key}</span>
        </>
      ),
    },
    { key: 'owner', header: 'Attaches to', cell: (t) => DOC_OWNER_LABELS[t.owner_type] },
    { key: 'kyc', header: 'KYC', cell: (t) => (t.is_kyc ? 'Yes' : 'No') },
    {
      key: 'expiry',
      header: 'Expiry',
      cell: (t) =>
        t.tracks_expiry
          ? [t.expiry_required ? 'Required' : 'Tracked', t.blocks_booking_when_expired ? 'blocks bookings' : null].filter(Boolean).join(', ')
          : 'Not tracked',
    },
    { key: 'view', header: 'Can view', cell: (t) => rolesText(t.view_roles) },
    { key: 'download', header: 'Can download', cell: (t) => rolesText(t.download_roles) },
    { key: 'retention', header: 'Retention', cell: (t) => retentionText(t) },
    { key: 'active', header: 'Status', cell: (t) => (t.active ? <Badge tone="green">Active</Badge> : <Badge tone="grey">Hidden</Badge>) },
    {
      key: 'edit',
      header: 'Edit',
      cell: (t) => (
        <Button variant="ghost" size="sm" icon={<Pencil size={16} aria-hidden="true" />} onClick={() => setEditing(t)} aria-label={`Edit ${t.label}`}>
          Edit
        </Button>
      ),
    },
  ];

  return (
    <Card>
      <CardHeader
        title="Document types"
        description="What can be uploaded, where it attaches, who can see it and how long it's kept. Hidden types can't be used for new uploads."
        actions={
          <Button size="sm" icon={<Plus size={16} aria-hidden="true" />} onClick={() => setEditing('new')}>
            Add type
          </Button>
        }
      />
      <CardBody>
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(t) => t.key}
          caption="Document types"
          mobileTitle={(t) => (
            <p className="m-0 font-semibold">
              {t.label} <span className="font-mono text-[13px] font-normal text-muted">{t.key}</span>
            </p>
          )}
        />
      </CardBody>
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        size="lg"
        title={editing === 'new' ? 'Add a document type' : editing ? `Edit ${editing.label}` : 'Document type'}
      >
        {editing && <TypeForm type={editing === 'new' ? null : editing} existing={rows} onDone={() => setEditing(null)} />}
      </Dialog>
    </Card>
  );
}

interface TypeState {
  key: string;
  label: string;
  owner_type: DocOwnerType;
  is_kyc: boolean;
  tracks_expiry: boolean;
  expiry_required: boolean;
  blocks_booking_when_expired: boolean;
  view_roles: AppRole[];
  download_roles: AppRole[];
  retention_days: string;
  retention_basis: Basis;
  active: boolean;
}

const fromType = (t: DocumentType | null): TypeState => ({
  key: t?.key ?? '',
  label: t?.label ?? '',
  owner_type: t?.owner_type ?? 'booking',
  is_kyc: t?.is_kyc ?? false,
  tracks_expiry: t?.tracks_expiry ?? false,
  expiry_required: t?.expiry_required ?? false,
  blocks_booking_when_expired: t?.blocks_booking_when_expired ?? false,
  view_roles: t?.view_roles ?? ['owner', 'manager'],
  download_roles: t?.download_roles ?? ['owner', 'manager'],
  retention_days: t?.retention_days === null || t?.retention_days === undefined ? '' : String(t.retention_days),
  retention_basis: t?.retention_basis ?? 'none',
  active: t?.active ?? true,
});

/** Keep the combination valid as boxes are ticked: download ⊆ view, Owner always, no Staff download of KYC. */
function normalise(s: TypeState): TypeState {
  const staffAllowed = s.owner_type === 'customer' || s.owner_type === 'booking';
  let view = [...new Set<AppRole>(['owner', ...s.view_roles])].filter((r) => r !== 'staff' || staffAllowed);
  if (s.owner_type === 'business') view = ['owner'];
  let download = [...new Set<AppRole>(['owner', ...s.download_roles])].filter((r) => view.includes(r));
  if (s.is_kyc) download = download.filter((r) => r !== 'staff');
  const tracks = s.tracks_expiry;
  const bases = BASES_FOR[s.owner_type];
  return {
    ...s,
    view_roles: APP_ROLES.filter((r) => view.includes(r)),
    download_roles: APP_ROLES.filter((r) => download.includes(r)),
    expiry_required: tracks && s.expiry_required,
    blocks_booking_when_expired: tracks && s.owner_type === 'car' && s.blocks_booking_when_expired,
    is_kyc: s.owner_type === 'customer' || s.owner_type === 'booking' ? s.is_kyc : false,
    retention_basis: bases.includes(s.retention_basis) ? s.retention_basis : 'none',
  };
}

function TypeForm({ type, existing, onDone }: { type: DocumentType | null; existing: DocumentType[]; onDone: () => void }) {
  const queryClient = useQueryClient();
  const isNew = type === null;
  const [s, setS] = useState<TypeState>(() => fromType(type));
  const [errors, setErrors] = useState<Partial<Record<'key' | 'label' | 'retention_days', string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const update = (patch: Partial<TypeState>) => setS((prev) => normalise({ ...prev, ...patch }));
  const toggleRole = (field: 'view_roles' | 'download_roles', role: AppRole, on: boolean) =>
    update({
      [field]: on ? [...s[field], role] : s[field].filter((r) => r !== role),
      // Ticking download also grants view.
      ...(field === 'download_roles' && on ? { view_roles: [...s.view_roles, role] } : {}),
    });

  const staffAllowed = s.owner_type === 'customer' || s.owner_type === 'booking';
  const bases = BASES_FOR[s.owner_type];

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs = new Errors<'key' | 'label' | 'retention_days'>();
    const key = s.key.trim();
    if (isNew) {
      if (!KEY_RE.test(key)) errs.set('key', 'Use lowercase letters, numbers and underscores, starting with a letter (2–41 characters), for example road_permit.');
      else if (existing.some((t) => t.key === key)) errs.set('key', 'That key is already used. Choose another.');
    }
    const label = s.label.trim();
    if (label.length < 2 || label.length > 80) errs.set('label', 'Enter a name of 2 to 80 characters.');
    const days = s.retention_basis === 'none' ? null : errs.take('retention_days', parseOptionalWhole(s.retention_days, 0, 3650));
    if (s.retention_basis !== 'none' && days === null && !errs.map.retention_days) errs.set('retention_days', 'Enter the number of days, or choose “No automatic erasure”.');
    setErrors(errs.map);
    if (!errs.ok) return;

    const fields = {
      label,
      is_kyc: s.is_kyc,
      tracks_expiry: s.tracks_expiry,
      expiry_required: s.expiry_required,
      blocks_booking_when_expired: s.blocks_booking_when_expired,
      view_roles: s.view_roles,
      download_roles: s.download_roles,
      retention_days: days,
      retention_basis: s.retention_basis,
      active: s.active,
    };
    setBusy(true);
    setFormError(null);
    try {
      if (isNew) {
        const sortOrder = Math.max(0, ...existing.map((t) => t.sort_order)) + 10;
        unwrap(await api.from('document_types').insert({ key, owner_type: s.owner_type, sort_order: sortOrder, ...fields }).select('key'));
      } else {
        unwrap(await api.from('document_types').update(fields).eq('key', type.key).select('key'));
      }
      await queryClient.invalidateQueries({ queryKey: qk.documentTypes });
      toast.success(isNew ? `Added “${label}”.` : `Saved “${label}”.`);
      onDone();
    } catch (err) {
      if (toAppError(err).code === '23505') setErrors({ key: 'That key is already used. Choose another.' });
      else setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Name" required error={errors.label}>
          <Input value={s.label} onChange={(e) => update({ label: e.target.value })} maxLength={80} autoFocus />
        </Field>
        {isNew ? (
          <Field label="Key" required error={errors.key} hint="Used inside the system and in file paths. Can't be changed later.">
            <Input
              value={s.key}
              onChange={(e) => update({ key: e.target.value.toLowerCase().replace(/[\s-]+/g, '_') })}
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
              maxLength={41}
            />
          </Field>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="m-0 font-semibold">Key</p>
            <p className="m-0 font-mono">{s.key}</p>
          </div>
        )}
        {isNew ? (
          <Field label="Attaches to" required hint="Can't be changed later.">
            <Select value={s.owner_type} onChange={(e) => update({ owner_type: e.target.value as DocOwnerType })}>
              {DOC_OWNER_TYPES.map((o) => (
                <option key={o} value={o}>
                  {DOC_OWNER_LABELS[o]}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="m-0 font-semibold">Attaches to</p>
            <p className="m-0">{DOC_OWNER_LABELS[s.owner_type]}</p>
          </div>
        )}
        <div className="flex flex-col justify-end">
          {isNew && staffAllowed ? (
            <Checkbox
              label="Customer KYC document"
              description="Licence or identity documents: verified at handover, never downloadable by Staff."
              checked={s.is_kyc}
              onChange={(e) => update({ is_kyc: e.target.checked })}
            />
          ) : (
            <p className="m-0 text-[15px]">
              <span className="font-semibold">KYC:</span> {s.is_kyc ? 'Yes, never downloadable by Staff' : 'No'}
            </p>
          )}
        </div>
      </div>

      <fieldset className="m-0 flex flex-col gap-1 rounded-xl border border-line-card p-3">
        <legend className="px-1 font-semibold">Expiry</legend>
        <Checkbox label="Track an expiry date" checked={s.tracks_expiry} onChange={(e) => update({ tracks_expiry: e.target.checked })} />
        {s.tracks_expiry && (
          <>
            <Checkbox label="Expiry date is required when uploading" checked={s.expiry_required} onChange={(e) => update({ expiry_required: e.target.checked })} />
            {s.owner_type === 'car' && (
              <Checkbox
                label="Block bookings for the car when expired"
                description="A booking can't be confirmed while this paper is expired, unless the Owner overrides with a reason."
                checked={s.blocks_booking_when_expired}
                onChange={(e) => update({ blocks_booking_when_expired: e.target.checked })}
              />
            )}
          </>
        )}
      </fieldset>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {(['view_roles', 'download_roles'] as const).map((field) => (
          <fieldset key={field} className="m-0 flex flex-col gap-1 rounded-xl border border-line-card p-3">
            <legend className="px-1 font-semibold">{field === 'view_roles' ? 'Who can view' : 'Who can download'}</legend>
            {APP_ROLES.map((r) => {
              const locked = r === 'owner';
              const staffBlocked = r === 'staff' && (!staffAllowed || (field === 'download_roles' && s.is_kyc));
              return (
                <Checkbox
                  key={r}
                  label={ROLE_LABELS[r]}
                  checked={s[field].includes(r)}
                  disabled={locked || staffBlocked || s.owner_type === 'business'}
                  onChange={(e) => toggleRole(field, r, e.target.checked)}
                  description={
                    locked
                      ? 'Owners always have access.'
                      : s.owner_type === 'business'
                        ? 'Business papers are for Owners only.'
                        : r === 'staff' && !staffAllowed
                          ? 'Staff only see customer and booking documents.'
                          : staffBlocked
                            ? 'Staff can never download KYC documents.'
                            : undefined
                  }
                />
              );
            })}
          </fieldset>
        ))}
      </div>

      <fieldset className="m-0 grid grid-cols-1 gap-4 rounded-xl border border-line-card p-3 md:grid-cols-2">
        <legend className="px-1 font-semibold">Retention</legend>
        <Field label="Erase files" hint={bases.length === 1 ? 'Vehicle and business papers are kept until the Owner removes them.' : undefined}>
          <Select value={s.retention_basis} onChange={(e) => update({ retention_basis: e.target.value as Basis })} disabled={bases.length === 1}>
            {bases.map((b) => (
              <option key={b} value={b}>
                {BASIS_LABELS[b]}
              </option>
            ))}
          </Select>
        </Field>
        {s.retention_basis !== 'none' && (
          <Field label="Days to keep" required error={errors.retention_days} hint="Files on hold for a fine, claim or dispute are always kept.">
            <Input inputMode="numeric" value={s.retention_days} onChange={(e) => update({ retention_days: e.target.value })} />
          </Field>
        )}
      </fieldset>

      <Checkbox
        label="Active"
        description="Hidden types stay on existing documents but can't be chosen for new uploads."
        checked={s.active}
        onChange={(e) => update({ active: e.target.checked })}
      />

      {formError && <Alert tone="error">{formError}</Alert>}
      <DialogFooter>
        <Button variant="secondary" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" loading={busy} loadingText="Saving…">
          {isNew ? 'Add type' : 'Save type'}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ---------------------------------------------------------------- retention settings

type RetentionKey = keyof RetentionSettings;

function RetentionForm({ initial, longestDocDays }: { initial: RetentionSettings; longestDocDays: number }) {
  const save = useSaveSetting('retention');
  const toForm = (r: RetentionSettings) => ({
    requests_days: String(r.requests_days),
    audit_days: String(r.audit_days),
    soft_delete_days: String(r.soft_delete_days),
  });
  const [form, setForm] = useState(() => toForm(initial));
  const [errors, setErrors] = useState<Partial<Record<RetentionKey, string>>>({});
  const dirty = !sameJson(form, toForm(initial));
  const auditMin = Math.max(1, longestDocDays);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs = new Errors<RetentionKey>();
    const value: RetentionSettings = {
      requests_days: errs.take('requests_days', parseWhole(form.requests_days, 1, 3650)),
      audit_days: errs.take('audit_days', parseWhole(form.audit_days, auditMin, 3650)),
      soft_delete_days: errs.take('soft_delete_days', parseWhole(form.soft_delete_days, 1, 365)),
    };
    if (errs.map.audit_days && /^\d+$/.test(form.audit_days.trim()) && Number(form.audit_days) < auditMin) {
      errs.map.audit_days = `Keep audit entries for at least ${auditMin} days: the longest document retention.`;
    }
    setErrors(errs.map);
    if (!errs.ok) {
      toast.error('Some periods need fixing. Check the highlighted fields.');
      return;
    }
    try {
      await save.mutateAsync(value);
      toast.success('Retention periods saved. The nightly clean-up uses them from tonight.');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const bind = (k: RetentionKey) => ({
    value: form[k],
    inputMode: 'numeric' as const,
    onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value })),
  });

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      <FormCard
        title="Retention periods"
        description="How long other records are kept before they're erased automatically. Document periods are set per type above."
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Unconfirmed and rejected requests (days)" error={errors.requests_days} hint="Requests that never became a booking.">
            <Input {...bind('requests_days')} />
          </Field>
          <Field
            label="Audit log (days)"
            error={errors.audit_days}
            hint={`At least ${auditMin} days (the longest document retention). At least 365 is recommended.`}
          >
            <Input {...bind('audit_days')} />
          </Field>
          <Field label="Deleted documents (days)" error={errors.soft_delete_days} hint="Kept hidden this long after deletion, then erased for good.">
            <Input {...bind('soft_delete_days')} />
          </Field>
        </div>
        {Number(form.audit_days) > 0 && Number(form.audit_days) < 365 && !errors.audit_days && (
          <Alert tone="warning">Less than a year of audit history may not be enough to look into a fine or dispute.</Alert>
        )}
      </FormCard>
      <SaveBar dirty={dirty} saving={save.isPending} hasErrors={Object.keys(errors).length > 0 && dirty} />
    </form>
  );
}
