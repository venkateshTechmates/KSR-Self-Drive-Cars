// DOC-10 (P1): cover the first 8 Aadhaar digits before saving. Everything happens in the
// browser, so the unmasked original never leaves the device and is never stored.
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { encodeCanvas, heicToJpeg, isHeic, loadImage } from '@/lib/images';

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function RedactionTool({ file, onDone, onCancel }: { file: File; onDone: (redacted: File) => void; onCancel: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<ImageBitmap | HTMLImageElement | null>(null);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [draft, setDraft] = useState<Box | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const source = (await isHeic(file)) ? await heicToJpeg(file) : file;
        const loaded = await loadImage(source);
        if (!cancelled) setImg(loaded);
      } catch {
        if (!cancelled) setError('This file cannot be edited here. Upload a masked copy instead.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file]);

  // Draw image + boxes at display size.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !img) return;
    const maxW = Math.min(720, canvas.parentElement?.clientWidth ?? 720);
    const scale = Math.min(1, maxW / img.width);
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    for (const b of [...boxes, ...(draft ? [draft] : [])]) ctx.fillRect(b.x * canvas.width, b.y * canvas.height, b.w * canvas.width, b.h * canvas.height);
  }, [img, boxes, draft]);

  const point = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };

  async function apply() {
    if (!img || boxes.length === 0) return;
    setBusy(true);
    try {
      const full = document.createElement('canvas');
      full.width = img.width;
      full.height = img.height;
      const ctx = full.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      ctx.fillStyle = '#000';
      for (const b of boxes) ctx.fillRect(b.x * img.width, b.y * img.height, b.w * img.width, b.h * img.height);
      const blob = await encodeCanvas(full, img.width, img.height, 'image/jpeg', 0.9);
      onDone(new File([blob], `${file.name.replace(/\.[^.]+$/, '')}-masked.jpg`, { type: 'image/jpeg' }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-[15px]">
        Drag over the <strong>first 8 digits</strong> of the Aadhaar number (and the QR code if shown) to cover them. Only the last 4 digits
        should stay visible.
      </p>
      {error && <p className="m-0 font-semibold text-danger">{error}</p>}
      <div className="overflow-hidden rounded-xl border border-line bg-tile">
        <canvas
          ref={canvasRef}
          className="block w-full touch-none cursor-crosshair"
          aria-label="Aadhaar image. Drag to draw black boxes over the digits to hide."
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            start.current = point(e);
            setDraft({ ...start.current, w: 0, h: 0 });
          }}
          onPointerMove={(e) => {
            if (!start.current) return;
            const p = point(e);
            setDraft({
              x: Math.min(start.current.x, p.x),
              y: Math.min(start.current.y, p.y),
              w: Math.abs(p.x - start.current.x),
              h: Math.abs(p.y - start.current.y),
            });
          }}
          onPointerUp={() => {
            if (draft && draft.w > 0.01 && draft.h > 0.01) setBoxes((b) => [...b, draft]);
            setDraft(null);
            start.current = null;
          }}
        />
      </div>
      <div className="flex flex-wrap justify-between gap-2">
        <Button variant="ghost" size="sm" icon={<Undo2 size={16} aria-hidden="true" />} onClick={() => setBoxes((b) => b.slice(0, -1))} disabled={!boxes.length}>
          Undo box
        </Button>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={apply} disabled={!boxes.length} loading={busy}>
            Use masked copy
          </Button>
        </div>
      </div>
    </div>
  );
}
