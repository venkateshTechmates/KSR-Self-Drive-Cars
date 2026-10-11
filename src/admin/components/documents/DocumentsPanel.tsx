// Documents attached to one customer, booking, car or the business (DOC-01, FLT-07, CUS-03).
import { useMemo, useState } from 'react';
import { Download, Eye, FileText, History, Image as ImageIcon, Lock, RefreshCw, ShieldCheck, Trash2, Undo2, Upload } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import type { DocOwnerType } from '@shared/constants.ts';
import { formatIsoDate } from '@shared/time.ts';
import { Badge, DocStatusPill, ExpiryPill } from '@/components/ui/Badges';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { Card, CardHeader, EmptyState } from '@/components/ui/Layout';
import { Spinner } from '@/components/ui/Spinner';
import { supabase } from '@/integrations/supabase/client';
import { downloadDocument } from '@/lib/documents';
import { errorMessage, unwrap } from '@/lib/errors';
import { formatBytes, formatDateTime } from '@/lib/format';
import type { DocumentRow, DocumentType } from '@/types/db';
import { isOwnerOrManager, useAuth } from '../../auth/AuthProvider';
import { qk, useDocumentTypes, useStaffName } from '../../hooks/queries';
import { canDownloadType, docExpiryState, isImage } from './docHelpers';
import { DocumentUploadDialog } from './DocumentUploadDialog';
import { DocumentViewer } from './DocumentViewer';
import { VerifyDocumentDialog } from './VerifyDialogs';

interface Props {
  ownerType: DocOwnerType;
  ownerId: string | null;
  title?: string;
  description?: string;
  /** Only show / allow these types. */
  docTypes?: string[];
  contextBookingId?: string | null;
  readOnly?: boolean;
  /** Types to list as "missing" when there is no current file (e.g. dl_front). */
  expected?: string[];
}

export function useOwnerDocuments(ownerType: DocOwnerType, ownerId: string | null, includeDeleted = false) {
  return useQuery({
    queryKey: [...qk.documentsFor(ownerType, ownerId), includeDeleted],
    queryFn: async () => {
      let q = supabase.from('documents').select('*').eq('owner_type', ownerType);
      if (ownerType !== 'business') q = q.eq('owner_id', ownerId!);
      if (!includeDeleted) q = q.is('deleted_at', null);
      return unwrap(await q.order('created_at', { ascending: false })) as DocumentRow[];
    },
    enabled: ownerType === 'business' || Boolean(ownerId),
  });
}

export function DocumentsPanel({ ownerType, ownerId, title = 'Documents', description, docTypes, contextBookingId, readOnly, expected = [] }: Props) {
  const { role } = useAuth();
  const queryClient = useQueryClient();
  const staffName = useStaffName();
  const { data: types = [] } = useDocumentTypes();
  const [showDeleted, setShowDeleted] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const docs = useOwnerDocuments(ownerType, ownerId, showDeleted && role === 'owner');

  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadType, setUploadType] = useState<string | undefined>();
  const [replacing, setReplacing] = useState<DocumentRow | null>(null);
  const [viewing, setViewing] = useState<DocumentRow | null>(null);
  const [verifying, setVerifying] = useState<DocumentRow | null>(null);
  const [deleting, setDeleting] = useState<DocumentRow | null>(null);
  const [holding, setHolding] = useState<DocumentRow | null>(null);

  const typeOf = useMemo(() => new Map(types.map((t) => [t.key, t])), [types]);
  const rows = (docs.data ?? []).filter((d) => !docTypes || docTypes.includes(d.doc_type));
  const current = rows.filter((d) => d.status !== 'superseded');
  const history = rows.filter((d) => d.status === 'superseded');
  const sorted = [...current].sort((a, b) => (typeOf.get(a.doc_type)?.sort_order ?? 0) - (typeOf.get(b.doc_type)?.sort_order ?? 0));
  const missing = expected.filter((k) => !current.some((d) => d.doc_type === k && !d.deleted_at));
  const canUpload = !readOnly && types.some((t) => t.owner_type === ownerType && role && t.view_roles.includes(role) && (!docTypes || docTypes.includes(t.key)));

  const refresh = () => queryClient.invalidateQueries({ queryKey: qk.documents });

  async function rpc(name: string, args: Record<string, unknown>, ok: string) {
    unwrap(await supabase.rpc(name, args));
    toast.success(ok);
    await refresh();
  }

  function openUpload(type?: string) {
    setReplacing(null);
    setUploadType(type);
    setUploadOpen(true);
  }

  const renderDoc = (d: DocumentRow) => {
    const t = typeOf.get(d.doc_type);
    const expiry = docExpiryState(d);
    return (
      <li key={d.id} className="flex flex-col gap-3 border-b border-line-card px-4 py-3 last:border-0 sm:flex-row sm:items-center sm:px-5">
        <button
          type="button"
          onClick={() => setViewing(d)}
          className="flex min-w-0 flex-1 items-start gap-3 bg-transparent text-left"
          aria-label={`View ${t?.label ?? d.doc_type}`}
        >
          <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-lg bg-tile text-ink-2">
            {isImage(d.mime_type) ? <ImageIcon size={20} aria-hidden="true" /> : <FileText size={20} aria-hidden="true" />}
          </span>
          <span className="min-w-0">
            <span className="block font-semibold">{t?.label ?? d.doc_type}</span>
            <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
              {t?.is_kyc && <DocStatusPill status={d.status} />}
              {!t?.is_kyc && d.status === 'expired' && <DocStatusPill status={d.status} />}
              {d.expiry_date && <ExpiryPill state={expiry} />}
              {d.legal_hold && (
                <Badge tone="dark" title={d.hold_reason ?? undefined}>
                  <Lock size={12} aria-hidden="true" /> On hold
                </Badge>
              )}
              {d.deleted_at && <Badge tone="red">Deleted</Badge>}
              {d.version > 1 && <Badge tone="outline">v{d.version}</Badge>}
              {d.uploaded_via === 'customer_link' && <Badge tone="outline">From customer</Badge>}
            </span>
            <span className="mt-1 block text-sm text-muted">
              {d.expiry_date && <>Expires {formatIsoDate(d.expiry_date)} · </>}
              {d.doc_number_masked && <>No. {d.doc_number_masked} · </>}
              {formatBytes(d.size_bytes)} · {staffName(d.uploaded_by)}, {formatDateTime(d.created_at)}
            </span>
            {d.status === 'rejected' && d.reject_reason && <span className="mt-1 block text-sm text-danger">Rejected: {d.reject_reason}</span>}
            {d.deleted_at && <span className="mt-1 block text-sm text-danger">Deleted: {d.delete_reason}. Erased after {d.retain_until ? formatDateTime(d.retain_until) : '30 days'}.</span>}
          </span>
        </button>
        <div className="flex flex-wrap items-center gap-1 sm:justify-end">
          <Button variant="ghost" size="sm" icon={<Eye size={16} aria-hidden="true" />} onClick={() => setViewing(d)}>
            View
          </Button>
          {canDownloadType(t, role) && !d.deleted_at && (
            <Button
              variant="ghost"
              size="sm"
              icon={<Download size={16} aria-hidden="true" />}
              onClick={() => downloadDocument(d.id).catch((err) => toast.error(errorMessage(err)))}
            >
              Download
            </Button>
          )}
          {t?.is_kyc && !d.deleted_at && d.status !== 'verified' && d.status !== 'superseded' && !readOnly && (
            <Button variant="ghost" size="sm" icon={<ShieldCheck size={16} aria-hidden="true" />} onClick={() => setVerifying(d)}>
              Verify
            </Button>
          )}
          {/* Only the current version can be replaced; replacing an old one would add a second current version. */}
          {!readOnly && !d.deleted_at && d.status !== 'superseded' && (
            <Button
              variant="ghost"
              size="sm"
              icon={<RefreshCw size={16} aria-hidden="true" />}
              onClick={() => {
                setReplacing(d);
                setUploadOpen(true);
              }}
            >
              Replace
            </Button>
          )}
          {isOwnerOrManager(role) && !d.deleted_at && (
            <Button
              variant="ghost"
              size="sm"
              icon={<Lock size={16} aria-hidden="true" />}
              onClick={() =>
                d.legal_hold
                  ? rpc('set_document_hold', { p_doc: d.id, p_hold: false, p_reason: null }, 'Hold removed').catch((e) => toast.error(errorMessage(e)))
                  : setHolding(d)
              }
            >
              {d.legal_hold ? 'Release' : 'Hold'}
            </Button>
          )}
          {role === 'owner' && !d.deleted_at && (
            <Button variant="ghost" size="sm" icon={<Trash2 size={16} aria-hidden="true" />} onClick={() => setDeleting(d)}>
              Delete
            </Button>
          )}
          {role === 'owner' && d.deleted_at && (
            <Button
              variant="ghost"
              size="sm"
              icon={<Undo2 size={16} aria-hidden="true" />}
              onClick={() => rpc('restore_document', { p_doc: d.id }, 'Restored').catch((e) => toast.error(errorMessage(e)))}
            >
              Restore
            </Button>
          )}
        </div>
      </li>
    );
  };

  return (
    <Card>
      <CardHeader
        title={title}
        description={description}
        actions={
          <>
            {history.length > 0 && (
              <Button variant="ghost" size="sm" icon={<History size={16} aria-hidden="true" />} onClick={() => setShowHistory((s) => !s)}>
                {showHistory ? 'Hide' : 'Show'} earlier versions ({history.length})
              </Button>
            )}
            {role === 'owner' && (
              <Button variant="ghost" size="sm" onClick={() => setShowDeleted((s) => !s)}>
                {showDeleted ? 'Hide deleted' : 'Show deleted'}
              </Button>
            )}
            {canUpload && (
              <Button size="sm" icon={<Upload size={16} aria-hidden="true" />} onClick={() => openUpload()}>
                Upload
              </Button>
            )}
          </>
        }
      />
      {docs.isLoading ? (
        <div className="flex justify-center p-6">
          <Spinner />
        </div>
      ) : docs.error ? (
        <p className="m-0 p-5 text-danger">{errorMessage(docs.error)}</p>
      ) : (
        <>
          {missing.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-2 border-b border-line-card bg-amber-50 p-4 sm:px-5">
              {missing.map((k) => (
                <li key={k} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-amber-900">{typeOf.get(k)?.label ?? k}: not uploaded</span>
                  {canUpload && (
                    <Button size="sm" variant="secondary" icon={<Upload size={16} aria-hidden="true" />} onClick={() => openUpload(k)}>
                      Upload
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {sorted.length === 0 && missing.length === 0 ? (
            <div className="p-4 sm:p-5">
              <EmptyState title="No documents yet" />
            </div>
          ) : (
            <ul className="m-0 list-none p-0">{sorted.map(renderDoc)}</ul>
          )}
          {showHistory && history.length > 0 && (
            <div className="border-t border-line-card bg-subtle">
              <p className="m-0 px-4 pt-3 text-sm font-semibold text-muted sm:px-5">Earlier versions</p>
              <ul className="m-0 list-none p-0">{history.map(renderDoc)}</ul>
            </div>
          )}
        </>
      )}

      <DocumentUploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        ownerType={ownerType}
        ownerId={ownerId}
        allowedTypes={docTypes}
        defaultType={uploadType}
        replaces={replacing}
        contextBookingId={contextBookingId}
      />
      <DocumentViewer doc={viewing} open={Boolean(viewing)} onClose={() => setViewing(null)} />
      <VerifyDocumentDialog
        doc={verifying}
        label={(verifying && typeOf.get(verifying.doc_type)?.label) || 'document'}
        open={Boolean(verifying)}
        onClose={() => setVerifying(null)}
      />
      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title="Delete this document?"
        description="It is hidden now and permanently erased after 30 days. You can restore it until then."
        confirmLabel="Delete"
        tone="danger"
        reasonLabel="Reason"
        onConfirm={(reason) => rpc('soft_delete_document', { p_doc: deleting!.id, p_reason: reason }, 'Deleted')}
      />
      <ConfirmDialog
        open={Boolean(holding)}
        onClose={() => setHolding(null)}
        title="Put this document on hold?"
        description="Documents on hold are skipped by automatic erasure, for example while a fine, claim or dispute is open."
        confirmLabel="Put on hold"
        reasonLabel="Reason"
        onConfirm={(reason) => rpc('set_document_hold', { p_doc: holding!.id, p_hold: true, p_reason: reason }, 'On hold')}
      />
    </Card>
  );
}

export type { DocumentType };
