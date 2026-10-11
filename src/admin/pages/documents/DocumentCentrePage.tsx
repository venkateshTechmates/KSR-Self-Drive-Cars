// Document centre (DOC-14): every document in one list with filters, expiry alerts (DOC-12) and upload (DOC-01).
// `?doc=<id>` opens that document's viewer directly (used by reminder emails).
import { useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Eye, FileText, Image as ImageIcon, Lock, ShieldCheck, SlidersHorizontal, Upload, X } from 'lucide-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { DOC_OWNER_LABELS, DOC_OWNER_TYPES, DOC_STATUS_LABELS, DOC_STATUSES, type DocOwnerType } from '@shared/constants.ts';
import { expiryState } from '@shared/documents.ts';
import { Badge, DocStatusPill, ExpiryPill } from '@/components/ui/Badges';
import { Button } from '@/components/ui/Button';
import { Alert, Field, Input, Select } from '@/components/ui/Field';
import { DataTable, EmptyState, PageHeader, type Column } from '@/components/ui/Layout';
import { PageSpinner } from '@/components/ui/Spinner';
import { api } from '@/integrations/api/client';
import { errorMessage, unwrap } from '@/lib/errors';
import { formatDateTime, formatIsoDate, formatPhone, istDateIso, pluralize } from '@/lib/format';
import { cn } from '@/lib/cn';
import { useNow } from '@/lib/useNow';
import type { Customer, DocumentRow, DocumentType } from '@/types/db';
import { useAuth } from '../../auth/AuthProvider';
import { useDocumentIdleTimeout } from '../../auth/guards';
import { DocumentUploadDialog } from '../../components/documents/DocumentUploadDialog';
import { DocumentViewer } from '../../components/documents/DocumentViewer';
import { VerifyDocumentDialog } from '../../components/documents/VerifyDialogs';
import { isImage } from '../../components/documents/docHelpers';
import { qk, useCars, useDocumentTypes, useStaffDirectory, useStaffName } from '../../hooks/queries';
import { CustomerPicker } from '../customers/CustomerPicker';
import { useDebounced } from '../customers/customerSearch';
import {
  countActiveFilters,
  EXPIRY_WINDOWS,
  fetchDocAlerts,
  fetchDocument,
  fetchDocuments,
  FILTER_KEYS,
  ownerName,
  PAGE_SIZE,
  readFilters,
  UUID_RE,
  type DocFilters,
  type DocListRow,
} from './documentCentreData';
import { UploadTargetDialog, type UploadTarget } from './UploadTargetDialog';

export default function DocumentCentrePage() {
  useDocumentIdleTimeout();
  const { role } = useAuth();
  const now = useNow();
  const todayIso = istDateIso(now);
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => readFilters(searchParams), [searchParams]);
  const [search, setSearch] = useState(() => searchParams.get('q') ?? '');
  const q = useDebounced(search.trim(), 350);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [filtersOpen, setFiltersOpen] = useState(() => countActiveFilters(readFilters(searchParams)) > 0);

  const { data: types = [] } = useDocumentTypes();
  const typeOf = useMemo(() => new Map(types.map((t) => [t.key, t])), [types]);
  const staffName = useStaffName();

  const [viewing, setViewing] = useState<DocumentRow | null>(null);
  const [verifying, setVerifying] = useState<DocumentRow | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [target, setTarget] = useState<UploadTarget | null>(null);

  const list = useQuery({
    queryKey: [...qk.documents, 'centre', filters, q, todayIso, limit],
    queryFn: () => fetchDocuments(filters, q, todayIso, limit),
    placeholderData: keepPreviousData,
  });
  const alerts = useQuery({ queryKey: [...qk.documents, 'alerts', todayIso], queryFn: () => fetchDocAlerts(todayIso) });

  // ?doc=<id> from email links.
  const docParam = searchParams.get('doc');
  const linkedId = docParam && UUID_RE.test(docParam) ? docParam : null;
  const linked = useQuery({
    queryKey: [...qk.documents, 'one', linkedId],
    enabled: Boolean(linkedId),
    queryFn: () => fetchDocument(linkedId!),
  });
  const viewerDoc = viewing ?? (linkedId ? (linked.data ?? null) : null);
  const linkMissing = Boolean(docParam) && (!linkedId || (linked.isSuccess && !linked.data));

  function updateParams(change: (p: URLSearchParams) => void) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        change(next);
        return next;
      },
      { replace: true },
    );
  }

  function setFilter<K extends keyof DocFilters>(key: K, value: DocFilters[K]) {
    setLimit(PAGE_SIZE);
    updateParams((p) => {
      if (!value || (key === 'status' && value === 'current')) p.delete(key);
      else p.set(key, String(value));
      // A type belongs to one category; drop it when the category changes.
      if (key === 'category' && value && filters.type && typeOf.get(filters.type)?.owner_type !== value) p.delete('type');
    });
  }

  function applyFilters(next: Partial<DocFilters>) {
    setLimit(PAGE_SIZE);
    if (Object.keys(next).length > 0) setFiltersOpen(true);
    updateParams((p) => {
      FILTER_KEYS.forEach((k) => p.delete(k));
      for (const [k, v] of Object.entries(next)) if (v) p.set(k, String(v));
    });
  }

  function closeViewer() {
    setViewing(null);
    if (docParam) updateParams((p) => p.delete('doc'));
  }

  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;
  const activeCount = countActiveFilters(filters);

  const columns: Column<DocListRow>[] = [
    { key: 'doc', header: 'Document', hideOnMobile: true, cell: (d) => <DocTitle doc={d} type={typeOf.get(d.doc_type)} /> },
    { key: 'owner', header: 'Belongs to', cell: (d) => <OwnerCell doc={d} /> },
    { key: 'status', header: 'Status', cell: (d) => <StatusCell doc={d} type={typeOf.get(d.doc_type)} todayIso={todayIso} /> },
    {
      key: 'expiry',
      header: 'Expiry',
      cell: (d) => (d.expiry_date ? <span className="whitespace-nowrap">{formatIsoDate(d.expiry_date)}</span> : <span className="text-muted">—</span>),
    },
    {
      key: 'uploaded',
      header: 'Uploaded',
      cell: (d) => (
        <span className="inline-block text-right md:text-left">
          <span className="block">{d.uploaded_via === 'customer_link' ? 'Customer (upload link)' : staffName(d.uploaded_by)}</span>
          <span className="block text-sm whitespace-nowrap text-muted">{formatDateTime(d.created_at)}</span>
        </span>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      cell: (d) => {
        const t = typeOf.get(d.doc_type);
        const label = t?.label ?? d.doc_type;
        const canVerify = t?.is_kyc && d.status !== 'verified' && d.status !== 'superseded';
        return (
          <span className="flex flex-wrap justify-end gap-1">
            <Button variant="ghost" size="sm" icon={<Eye size={16} aria-hidden="true" />} onClick={() => setViewing(d)}>
              View<span className="sr-only">: {label}, {ownerName(d)}</span>
            </Button>
            {canVerify && (
              <Button variant="ghost" size="sm" icon={<ShieldCheck size={16} aria-hidden="true" />} onClick={() => setVerifying(d)}>
                Verify<span className="sr-only">: {label}, {ownerName(d)}</span>
              </Button>
            )}
          </span>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="Document centre"
        description="Every customer, booking, vehicle and business document in one place."
        actions={
          <Button icon={<Upload size={18} aria-hidden="true" />} onClick={() => setChoosing(true)}>
            Upload
          </Button>
        }
      />

      {linkMissing && (
        <Alert tone="warning" className="mb-4" title="That document isn't available">
          <p className="m-0">It may have been deleted, or your role can&apos;t open it.</p>
          <Button variant="ghost" size="sm" className="mt-1 -ml-4" onClick={() => updateParams((p) => p.delete('doc'))}>
            Dismiss
          </Button>
        </Alert>
      )}

      <AlertTiles
        alerts={alerts.data}
        error={alerts.error}
        onExpired={() => applyFilters({ category: 'car', expiry: 'expired' })}
        onExpiring={() => applyFilters({ category: 'car', expiry: '30' })}
        onPending={() => applyFilters({ status: 'pending' })}
      />

      <div className="mb-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          {/* Plain label: the hint sits below the whole row so the buttons line up with the box. */}
          <div className="flex w-full flex-col gap-2 sm:w-[28rem]">
            <label htmlFor="doc-search" className="font-semibold">
              Search
            </label>
            <Input
              id="doc-search"
              aria-describedby="doc-search-hint"
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setLimit(PAGE_SIZE);
              }}
              autoComplete="off"
            />
          </div>
          <Button
            variant="secondary"
            icon={<SlidersHorizontal size={16} aria-hidden="true" />}
            aria-expanded={filtersOpen}
            aria-controls="doc-filters"
            onClick={() => setFiltersOpen((o) => !o)}
          >
            Filters{activeCount > 0 ? ` (${activeCount})` : ''}
          </Button>
          {activeCount > 0 && (
            <Button variant="ghost" icon={<X size={16} aria-hidden="true" />} onClick={() => applyFilters({})}>
              Clear filters
            </Button>
          )}
        </div>
        <p id="doc-search-hint" className="m-0 -mt-1 text-sm text-muted">
          Search by customer name or mobile, car registration, booking code, or the last 4 digits of a document number.
        </p>
        {filtersOpen && <FiltersPanel filters={filters} types={types} role={role} setFilter={setFilter} />}
      </div>

      <p className="m-0 mb-3 text-sm text-muted" aria-live="polite">
        {list.data ? `Showing ${rows.length} of ${pluralize(total, 'document')}` : list.isFetching ? 'Loading documents…' : ''}
      </p>

      {list.error ? (
        <Alert>{errorMessage(list.error)}</Alert>
      ) : list.isLoading ? (
        <PageSpinner label="Loading documents" />
      ) : (
        <>
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(d) => d.id}
            caption="Documents"
            mobileTitle={(d) => <DocTitle doc={d} type={typeOf.get(d.doc_type)} />}
            empty={
              <EmptyState title={q || activeCount > 0 ? 'No documents match' : 'No documents yet'}>
                {q || activeCount > 0 ? 'Try fewer filters, or search by the last 4 digits of the document number.' : 'Upload a document to get started.'}
              </EmptyState>
            }
          />
          {rows.length < total && (
            <div className="mt-4 flex justify-center">
              <Button variant="secondary" onClick={() => setLimit((l) => l + PAGE_SIZE)} loading={list.isFetching}>
                Show more
              </Button>
            </div>
          )}
        </>
      )}

      <DocumentViewer doc={viewerDoc} open={Boolean(viewerDoc)} onClose={closeViewer} />
      <VerifyDocumentDialog
        doc={verifying}
        label={(verifying && typeOf.get(verifying.doc_type)?.label) || 'document'}
        open={Boolean(verifying)}
        onClose={() => setVerifying(null)}
      />
      <UploadTargetDialog
        open={choosing}
        onClose={() => setChoosing(false)}
        onChoose={(t) => {
          setChoosing(false);
          setTarget(t);
        }}
      />
      <DocumentUploadDialog
        open={Boolean(target)}
        onClose={() => setTarget(null)}
        ownerType={target?.ownerType ?? 'customer'}
        ownerId={target?.ownerId ?? null}
      />
    </>
  );
}

// ------------------------------------------------------------------ summary

function AlertTiles({
  alerts,
  error,
  onExpired,
  onExpiring,
  onPending,
}: {
  alerts: { expiredPapers: number; expiringPapers: number; pendingKyc: number } | undefined;
  error: unknown;
  onExpired: () => void;
  onExpiring: () => void;
  onPending: () => void;
}) {
  if (error) return <Alert className="mb-4">{errorMessage(error)}</Alert>;
  const tiles = [
    { label: 'Vehicle papers expired', value: alerts?.expiredPapers, tone: 'red' as const, onClick: onExpired },
    { label: 'Vehicle papers expiring in 30 days', value: alerts?.expiringPapers, tone: 'amber' as const, onClick: onExpiring },
    { label: 'Customer documents to verify', value: alerts?.pendingKyc, tone: 'amber' as const, onClick: onPending },
  ];
  return (
    <section aria-label="Document alerts" className="mb-5 grid gap-3 sm:grid-cols-3">
      {tiles.map((t) => {
        const hot = (t.value ?? 0) > 0;
        return (
          <button
            key={t.label}
            type="button"
            onClick={t.onClick}
            className={cn(
              'flex min-h-11 flex-col items-start gap-1 rounded-2xl border bg-surface px-4 py-3 text-left hover:border-ink',
              hot && t.tone === 'red' ? 'border-danger/50 bg-danger-bg' : hot ? 'border-amber-300 bg-amber-50' : 'border-line-card',
            )}
          >
            <span className={cn('text-[28px] leading-none font-extrabold', hot && t.tone === 'red' ? 'text-danger' : 'text-ink')}>
              {t.value === undefined ? '…' : t.value}
            </span>
            <span className="font-semibold">{t.label}</span>
            <span className="text-sm text-muted">{hot ? 'Show them' : 'Nothing to do'}</span>
          </button>
        );
      })}
    </section>
  );
}

// ------------------------------------------------------------------ filters

function FiltersPanel({
  filters: f,
  types,
  role,
  setFilter,
}: {
  filters: DocFilters;
  types: DocumentType[];
  role: string | null;
  setFilter: <K extends keyof DocFilters>(key: K, value: DocFilters[K]) => void;
}) {
  const { data: cars = [] } = useCars();
  const { data: staff = [] } = useStaffDirectory();
  const categories = DOC_OWNER_TYPES.filter((c) => c !== 'business' || role === 'owner');
  const typeOptions = types.filter((t) => !f.category || t.owner_type === f.category);

  return (
    <div id="doc-filters" className="grid gap-3 rounded-2xl border border-line-card bg-surface p-4 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Category">
        <Select value={f.category} onChange={(e) => setFilter('category', e.target.value as DocOwnerType | '')}>
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {DOC_OWNER_LABELS[c]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Document type">
        <Select value={f.type} onChange={(e) => setFilter('type', e.target.value)}>
          <option value="">All types</option>
          {f.category
            ? typeOptions.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))
            : categories.map((c) => (
                <optgroup key={c} label={DOC_OWNER_LABELS[c]}>
                  {typeOptions
                    .filter((t) => t.owner_type === c)
                    .map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.label}
                      </option>
                    ))}
                </optgroup>
              ))}
        </Select>
      </Field>
      <Field label="Status">
        <Select value={f.status} onChange={(e) => setFilter('status', e.target.value as DocFilters['status'])}>
          <option value="current">Current (hide superseded)</option>
          {DOC_STATUSES.map((s) => (
            <option key={s} value={s}>
              {DOC_STATUS_LABELS[s]}
            </option>
          ))}
          <option value="all">All, including superseded</option>
        </Select>
      </Field>
      <Field label="Expiry">
        <Select value={f.expiry} onChange={(e) => setFilter('expiry', e.target.value as DocFilters['expiry'])}>
          {EXPIRY_WINDOWS.map((w) => (
            <option key={w.value} value={w.value}>
              {w.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Car" hint="Vehicle papers for this car">
        <Select value={f.car} onChange={(e) => setFilter('car', e.target.value)}>
          <option value="">All cars</option>
          {cars.map((c) => (
            <option key={c.id} value={c.id}>
              {c.display_name}
              {c.registration_number ? ` · ${c.registration_number}` : ''}
            </option>
          ))}
        </Select>
      </Field>
      <CustomerFilter customerId={f.customer} onChange={(id) => setFilter('customer', id)} />
      <Field label="Uploaded by">
        <Select value={f.by} onChange={(e) => setFilter('by', e.target.value)}>
          <option value="">Anyone</option>
          <option value="customer_link">Customer (upload link)</option>
          {staff.map((s) => (
            <option key={s.user_id} value={s.user_id}>
              {s.full_name}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Uploaded from">
          <Input type="date" value={f.from} max={f.to || undefined} onChange={(e) => setFilter('from', e.target.value)} />
        </Field>
        <Field label="Uploaded to">
          <Input type="date" value={f.to} min={f.from || undefined} onChange={(e) => setFilter('to', e.target.value)} />
        </Field>
      </div>
    </div>
  );
}

/** Customer filter: the chosen customer (from the URL) or a search box. */
function CustomerFilter({ customerId, onChange }: { customerId: string; onChange: (id: string) => void }) {
  const chosen = useQuery({
    queryKey: [...qk.customer(customerId), 'name'],
    enabled: Boolean(customerId),
    queryFn: async () => unwrap(await api.from('customers').select('*').eq('id', customerId).maybeSingle()) as Customer | null,
  });
  if (customerId) {
    const c = chosen.data;
    return (
      <div className="flex flex-col gap-2">
        <p className="m-0 font-semibold">Customer</p>
        <div className="flex min-h-[52px] items-center justify-between gap-2 rounded-xl border border-line-input bg-subtle py-1 pr-1 pl-3.5">
          <span className="min-w-0 truncate">
            {c ? (
              <>
                <span className="font-semibold">{c.full_name}</span>
                {c.phone && <span className="text-sm text-muted"> · {formatPhone(c.phone)}</span>}
              </>
            ) : chosen.isLoading ? (
              'Loading…'
            ) : (
              'Customer not found'
            )}
          </span>
          <Button variant="ghost" size="sm" onClick={() => onChange('')}>
            Clear<span className="sr-only"> customer filter</span>
          </Button>
        </div>
      </div>
    );
  }
  return <CustomerPicker value={null} onChange={(c) => onChange(c?.id ?? '')} hint="Name or mobile" />;
}

// ------------------------------------------------------------------ cells

function DocTitle({ doc: d, type }: { doc: DocListRow; type: DocumentType | undefined }) {
  return (
    <span className="flex items-start gap-3">
      <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-tile text-ink-2" aria-hidden="true">
        {isImage(d.mime_type) ? <ImageIcon size={18} /> : <FileText size={18} />}
      </span>
      <span className="min-w-0">
        <span className="block font-semibold">{type?.label ?? d.doc_type}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1 text-sm text-muted">
          {d.doc_number_masked && <span className="font-mono">No. {d.doc_number_masked}</span>}
          {d.version > 1 && <Badge tone="outline">v{d.version}</Badge>}
          {d.uploaded_via === 'customer_link' && <Badge tone="outline">From customer</Badge>}
          {d.legal_hold && (
            <Badge tone="dark" title={d.hold_reason ?? undefined}>
              <Lock size={12} aria-hidden="true" /> On hold
            </Badge>
          )}
        </span>
      </span>
    </span>
  );
}

function OwnerCell({ doc: d }: { doc: DocListRow }) {
  const category = <span className="block text-sm text-muted">{DOC_OWNER_LABELS[d.owner_type]}</span>;
  let main: ReactNode;
  if (d.owner_type === 'customer') {
    main = d.customer ? (
      <Link to={`/admin/customers/${d.customer.id}`} className="font-semibold text-ink">
        {d.customer.full_name}
      </Link>
    ) : (
      'Customer'
    );
  } else if (d.owner_type === 'booking') {
    main = d.booking ? (
      <>
        <Link to={`/admin/bookings/${d.booking.booking_code}`} className="font-mono text-[14px] font-semibold text-ink">
          {d.booking.booking_code}
        </Link>
        {d.booking.customer && (
          <Link to={`/admin/customers/${d.booking.customer.id}`} className="block text-sm text-ink-2">
            {d.booking.customer.full_name}
          </Link>
        )}
      </>
    ) : (
      'Booking'
    );
  } else if (d.owner_type === 'car') {
    main = d.car ? (
      <>
        <Link to={`/admin/fleet/${d.car.id}`} className="font-semibold text-ink">
          {d.car.display_name}
        </Link>
        {d.car.registration_number && <span className="block font-mono text-sm text-muted">{d.car.registration_number}</span>}
      </>
    ) : (
      'Vehicle'
    );
  } else {
    main = <span className="font-semibold">Business</span>;
  }
  return (
    <span className="inline-block text-right md:text-left">
      {category}
      {main}
    </span>
  );
}

function StatusCell({ doc: d, type, todayIso }: { doc: DocListRow; type: DocumentType | undefined; todayIso: string }) {
  // Non-KYC papers are stored as "verified"; only show their status when it says something.
  const showStatus = type?.is_kyc || d.status === 'expired' || d.status === 'superseded' || d.status === 'rejected';
  const expiry = d.status === 'superseded' ? null : expiryState(d.expiry_date, todayIso);
  if (!showStatus && !expiry) return <span className="text-muted">—</span>;
  return (
    <span className="inline-flex flex-wrap justify-end gap-1 md:justify-start">
      {showStatus && <DocStatusPill status={d.status} />}
      {expiry && <ExpiryPill state={expiry} />}
    </span>
  );
}
