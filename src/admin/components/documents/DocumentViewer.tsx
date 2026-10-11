// In-app viewer (DOC-06): images with zoom and rotate, PDFs inline. Files open through a
// 5-minute signed link, and each open is logged (DOC-05, DOC-07). KYC images show a
// watermark, also burned into downloaded copies (DOC-17).
import { useState } from 'react';
import { Download, RotateCw, ZoomIn, ZoomOut } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Button, IconButton } from '@/components/ui/Button';
import { Dialog, DialogFooter } from '@/components/ui/Dialog';
import { Alert } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Spinner';
import { api } from '@/integrations/api/client';
import { downloadDocument, getDocumentUrl } from '@/lib/documents';
import { encodeCanvas, loadImage } from '@/lib/images';
import { errorMessage } from '@/lib/errors';
import type { DocumentRow } from '@/types/db';
import { isImage } from './docHelpers';

interface Access {
  can_view: boolean;
  can_download: boolean;
  is_kyc?: boolean;
  label?: string;
}

export function DocumentViewer({ doc, open, onClose }: { doc: DocumentRow | null; open: boolean; onClose: () => void }) {
  const access = useQuery({
    queryKey: ['document-access', doc?.id],
    enabled: open && Boolean(doc),
    queryFn: async () => {
      const { data, error } = await api.rpc('document_access', { p_doc: doc!.id });
      if (error) throw error;
      return data as Access;
    },
  });
  const title = access.data?.label ?? doc?.original_filename ?? 'Document';
  return (
    <Dialog
      open={open && Boolean(doc)}
      onClose={onClose}
      size="xl"
      title={title}
      description={doc ? `${doc.original_filename} · version ${doc.version}` : undefined}
    >
      {doc && <ViewerBody key={doc.id} doc={doc} title={title} canDownload={Boolean(access.data?.can_download)} onClose={onClose} />}
    </Dialog>
  );
}

function ViewerBody({ doc, title, canDownload, onClose }: { doc: DocumentRow; title: string; canDownload: boolean; onClose: () => void }) {
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [downloading, setDownloading] = useState(false);

  // A fresh signed link (and audit entry) every time the viewer opens.
  const signed = useQuery({
    queryKey: ['document-url', doc.id],
    queryFn: () => getDocumentUrl(doc.id),
    staleTime: 4 * 60_000,
    gcTime: 0,
    retry: false,
  });

  async function download() {
    setDownloading(true);
    try {
      const watermark = signed.data?.watermark;
      if (watermark && isImage(doc.mime_type)) {
        // Fetch through a fresh signed download link and burn the watermark in (DOC-17).
        const s = await getDocumentUrl(doc.id, { download: true });
        const blob = await (await fetch(s.url)).blob();
        const img = await loadImage(blob);
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        drawWatermark(ctx, img.width, img.height, watermark);
        const out = await encodeCanvas(canvas, img.width, img.height, 'image/jpeg', 0.9);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(out);
        a.download = s.filename.replace(/\.[^.]+$/, '') + '.jpg';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      } else {
        await downloadDocument(doc.id);
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <>
      {signed.isLoading && (
        <div className="flex justify-center py-16">
          <Spinner size={28} label="Opening document" />
        </div>
      )}
      {signed.error && <Alert>{errorMessage(signed.error)}</Alert>}
      {signed.data && (
        <div className="relative overflow-auto rounded-xl bg-tile" style={{ maxHeight: '64dvh' }}>
          {isImage(doc.mime_type) ? (
            <div className="relative flex min-h-[40dvh] items-center justify-center p-2">
              <img
                src={signed.data.url}
                alt={title}
                draggable={false}
                className="max-w-full origin-center select-none transition-transform"
                style={{ transform: `scale(${zoom}) rotate(${rotation}deg)` }}
              />
              {signed.data.watermark && <WatermarkOverlay text={signed.data.watermark} />}
            </div>
          ) : (
            <iframe src={signed.data.url} title={title} className="h-[64dvh] w-full border-0 bg-white" />
          )}
        </div>
      )}
      {signed.data && <p className="m-0 mt-3 text-sm text-muted">This view was logged. The link expires in 5 minutes.</p>}
      <DialogFooter>
        {isImage(doc.mime_type) && (
          <div className="mr-auto flex items-center gap-1">
            <IconButton label="Zoom out" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}>
              <ZoomOut size={20} aria-hidden="true" />
            </IconButton>
            <span className="w-12 text-center text-sm tabular-nums" aria-live="polite">
              {Math.round(zoom * 100)}%
            </span>
            <IconButton label="Zoom in" onClick={() => setZoom((z) => Math.min(4, z + 0.25))}>
              <ZoomIn size={20} aria-hidden="true" />
            </IconButton>
            <IconButton label="Rotate" onClick={() => setRotation((r) => (r + 90) % 360)}>
              <RotateCw size={20} aria-hidden="true" />
            </IconButton>
          </div>
        )}
        {canDownload && (
          <Button variant="secondary" onClick={download} loading={downloading} icon={<Download size={18} aria-hidden="true" />}>
            Download
          </Button>
        )}
        <Button onClick={onClose}>Close</Button>
      </DialogFooter>
    </>
  );
}

function WatermarkOverlay({ text }: { text: string }) {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-16 overflow-hidden">
      {[0, 1, 2].map((i) => (
        <span key={i} className="-rotate-[24deg] text-center text-lg font-bold whitespace-nowrap text-black/25 sm:text-2xl">
          {text}
        </span>
      ))}
    </div>
  );
}

function drawWatermark(ctx: CanvasRenderingContext2D, w: number, h: number, text: string) {
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(-0.42);
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.font = `bold ${Math.max(18, Math.round(w / 28))}px sans-serif`;
  ctx.textAlign = 'center';
  const step = Math.max(80, Math.round(h / 4));
  for (let y = -h; y <= h; y += step) ctx.fillText(text, 0, y);
  ctx.restore();
}
