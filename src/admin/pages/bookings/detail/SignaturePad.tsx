// HND-02: the customer signs on the phone screen. Draws with pointer events on a <canvas>
// and reports a PNG after every stroke (null when cleared).
import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Eraser } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

const WIDTH = 900;
const HEIGHT = 320;
const INK = '#1d2125';
const LINE = 4;

function paper(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

export function SignaturePad({
  label,
  hint,
  error,
  onChange,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  onChange: (png: Blob | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [hasInk, setHasInk] = useState(false);
  const id = useId();

  useEffect(() => {
    if (canvasRef.current) paper(canvasRef.current);
  }, []);

  const pointOf = (canvas: HTMLCanvasElement, clientX: number, clientY: number) => {
    const r = canvas.getBoundingClientRect();
    return { x: ((clientX - r.left) * canvas.width) / r.width, y: ((clientY - r.top) * canvas.height) / r.height };
  };

  function down(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const canvas = e.currentTarget;
    canvas.setPointerCapture(e.pointerId);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    drawing.current = true;
    const p = pointOf(canvas, e.clientX, e.clientY);
    last.current = p;
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(p.x, p.y, LINE / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  function move(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawing.current || !last.current) return;
    const canvas = e.currentTarget;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.strokeStyle = INK;
    ctx.lineWidth = LINE;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const events = e.nativeEvent.getCoalescedEvents?.() ?? [];
    const points = (events.length ? events : [e.nativeEvent]).map((ev) => pointOf(canvas, ev.clientX, ev.clientY));
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    for (const p of points) ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = points[points.length - 1];
  }

  function up(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    setHasInk(true);
    e.currentTarget.toBlob((blob) => onChange(blob), 'image/png');
  }

  function clear() {
    if (canvasRef.current) paper(canvasRef.current);
    setHasInk(false);
    onChange(null);
  }

  return (
    <div className="flex flex-col gap-2">
      <p id={`${id}-label`} className="m-0 font-semibold">
        {label}
      </p>
      {hint && (
        <p id={`${id}-hint`} className="m-0 text-sm text-muted">
          {hint}
        </p>
      )}
      <div className={cn('relative overflow-hidden rounded-xl border-2 bg-white', error ? 'border-danger' : 'border-line-input')}>
        <canvas
          ref={canvasRef}
          width={WIDTH}
          height={HEIGHT}
          role="img"
          aria-labelledby={`${id}-label`}
          aria-describedby={[hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined}
          className="block aspect-[45/16] w-full cursor-crosshair touch-none"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        />
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-6 bottom-[22%] border-b-2 border-dashed border-line-dash" />
        {!hasInk && (
          <span aria-hidden="true" className="pointer-events-none absolute bottom-[8%] left-6 text-sm text-muted">
            Sign above the line
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm text-muted" aria-live="polite">
          {hasInk ? 'Signature captured.' : 'No signature yet.'}
        </span>
        <Button variant="ghost" size="sm" icon={<Eraser size={16} aria-hidden="true" />} onClick={clear} disabled={!hasInk}>
          Clear signature
        </Button>
      </div>
      {error && (
        <p id={`${id}-error`} className="m-0 text-sm font-semibold text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
