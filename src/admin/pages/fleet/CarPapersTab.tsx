// Papers tab: vehicle papers through the document centre (FLT-07, DOC-12), the FLT-08 alert
// for expired or missing insurance / PUC / permit, and the Owner's ZIP download (DOC-18).
import { useState } from 'react';
import { FileArchive } from 'lucide-react';
import toast from 'react-hot-toast';
import { zipSync } from 'fflate';
import { expiryState } from '@shared/documents.ts';
import { formatIsoDate } from '@shared/time.ts';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Field';
import { api } from '@/integrations/api/client';
import { saveFile } from '@/lib/download';
import { getDocumentUrl } from '@/lib/documents';
import { AppError, errorMessage, unwrap } from '@/lib/errors';
import { istDateIso } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import type { Car, DocumentRow } from '@/types/db';
import { useRole } from '../../auth/AuthProvider';
import { DocumentsPanel, useOwnerDocuments } from '../../components/documents/DocumentsPanel';
import { useDocumentTypes } from '../../hooks/queries';
import { blockingPaperTypes, usePaperProblems } from './fleetData';

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() || 'file';

export function CarPapersTab({ car }: { car: Car }) {
  const role = useRole();
  const now = useNow();
  const today = istDateIso(now);
  const problems = usePaperProblems(car.id);
  const docs = useOwnerDocuments('car', car.id);
  const types = useDocumentTypes();
  const [zipping, setZipping] = useState<string | null>(null);

  const typeLabel = (key: string) => types.data?.find((t) => t.key === key)?.label ?? key;
  const current = (docs.data ?? []).filter((d) => !d.deleted_at && d.status !== 'superseded');
  const blockingKeys = new Set(blockingPaperTypes(types.data).map((t) => t.key));
  const expiring = current.filter(
    (d) => blockingKeys.has(d.doc_type) && d.status !== 'rejected' && expiryState(d.expiry_date, today) === 'expiring_soon',
  );
  const expired = (problems.data ?? []).filter((p) => p.problem === 'expired');
  const missing = (problems.data ?? []).filter((p) => p.problem === 'missing');

  async function downloadAll() {
    if (!current.length) {
      toast.error('There are no papers to download yet. Upload them first.');
      return;
    }
    try {
      const files: Record<string, Uint8Array> = {};
      const used = new Set<string>();
      for (const [i, d] of current.entries()) {
        setZipping(`Preparing ${i + 1} of ${current.length}…`);
        // Each signed link is written to the audit log by the server (DOC-07).
        const signed = await getDocumentUrl(d.id, { download: true });
        const res = await fetch(signed.url);
        if (!res.ok) throw new AppError(`Couldn't download ${typeLabel(d.doc_type)}. Try again.`);
        files[uniqueName(d, signed.filename || d.original_filename, used)] = new Uint8Array(await res.arrayBuffer());
      }
      setZipping('Making the ZIP…');
      // Images and PDFs are already compressed, so store them as they are.
      const zipped = zipSync(files, { level: 0 });
      await saveFile(new Blob([new Uint8Array(zipped)], { type: 'application/zip' }), `${car.slug}-papers.zip`);
      unwrap(
        await api.rpc('log_client_event', {
          p_action: 'documents.bulk_download',
          p_entity_type: 'cars',
          p_entity_id: car.id,
          p_meta: { count: current.length },
        }),
      );
      toast.success(`Downloaded ${current.length} ${current.length === 1 ? 'file' : 'files'}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setZipping(null);
    }
  }

  function uniqueName(d: DocumentRow, filename: string, used: Set<string>) {
    const base = safeName(`${typeLabel(d.doc_type)}${d.version > 1 ? ` v${d.version}` : ''} - ${filename}`);
    let name = base;
    for (let n = 2; used.has(name); n += 1) name = base.replace(/(\.[^.]+)?$/, ` (${n})$1`);
    used.add(name);
    return name;
  }

  return (
    <div className="flex flex-col gap-5">
      {problems.error && <Alert title="Couldn't check the papers">{errorMessage(problems.error)}</Alert>}
      {expired.length > 0 && (
        <Alert title="Bookings for this car can't be confirmed">
          <ul className="m-0 pl-5">
            {expired.map((p) => (
              <li key={p.doc_type}>
                {p.label} expired{p.expiry_date ? ` on ${formatIsoDate(p.expiry_date)}` : ''}.
              </li>
            ))}
          </ul>
          <p className="m-0 mt-1">Upload the renewed paper with Replace. Only the Owner can override, with a reason.</p>
        </Alert>
      )}
      {missing.length > 0 && (
        <Alert tone="warning" title="Papers missing">
          {missing.map((p) => p.label).join(', ')} {missing.length === 1 ? 'is' : 'are'} not uploaded yet. Upload {missing.length === 1 ? 'it' : 'them'} below.
        </Alert>
      )}
      {expiring.length > 0 && (
        <Alert tone="warning" title="Expiring within 30 days">
          <ul className="m-0 pl-5">
            {expiring.map((d) => (
              <li key={d.id}>
                {typeLabel(d.doc_type)} expires on {formatIsoDate(d.expiry_date!)}.
              </li>
            ))}
          </ul>
        </Alert>
      )}
      {problems.data && !expired.length && !missing.length && !expiring.length && (
        <Alert tone="success">Insurance, PUC and permit are in date.</Alert>
      )}

      {role === 'owner' && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            icon={<FileArchive size={18} aria-hidden="true" />}
            loading={Boolean(zipping)}
            loadingText={zipping ?? undefined}
            disabled={docs.isLoading || current.length === 0}
            onClick={() => void downloadAll()}
          >
            Download all papers (ZIP)
          </Button>
          <span className="text-sm text-muted">Current versions only. Each file download is logged.</span>
        </div>
      )}

      <DocumentsPanel ownerType="car" ownerId={car.id} expected={['rc', 'insurance', 'puc', 'permit']} title="Vehicle papers" />
    </div>
  );
}
