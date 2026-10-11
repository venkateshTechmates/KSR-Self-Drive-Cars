// Handover photos (HND-01, HND-03): one slot per view of the car. Each photo uploads as soon as
// it is taken, so nothing is lost if the form is closed. The camera opens directly on phones (DOC-02).
import { useRef } from 'react';
import { Camera, Check, ImagePlus } from 'lucide-react';
import { Button, IconButton } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { pluralize } from '@/lib/format';
import { cn } from '@/lib/cn';
import { EMPTY_SLOT, type PhotoUploads, type Slot } from './usePhotoUploads';

export function PhotoSlots({ uploads, slots, label }: { uploads: PhotoUploads; slots: readonly Slot[]; label: string }) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const pending = useRef<Slot | null>(null);

  function pick(slot: Slot, source: 'camera' | 'gallery') {
    pending.current = slot;
    (source === 'camera' ? cameraRef : galleryRef).current?.click();
  }

  function onFiles(input: HTMLInputElement) {
    const slot = pending.current;
    const files = input.files ? Array.from(input.files) : [];
    input.value = '';
    if (slot && files.length) void uploads.upload(slot, files);
  }

  const done = slots.filter((s) => uploads.has(s.key)).length;

  return (
    <div className="flex flex-col gap-3">
      <ul className="m-0 grid list-none grid-cols-1 gap-2 p-0 md:grid-cols-2">
        {slots.map((slot) => {
          const st = uploads.slots[slot.key] ?? EMPTY_SLOT;
          const ok = st.count > 0;
          return (
            <li key={slot.key} className={cn('flex items-center gap-3 rounded-xl border p-2 pl-3', ok ? 'border-emerald-300 bg-emerald-50' : 'border-line-card bg-white')}>
              <span
                aria-hidden="true"
                className={cn('flex size-9 shrink-0 items-center justify-center rounded-full', ok ? 'bg-emerald-600 text-white' : 'bg-tile text-ink-2')}
              >
                {st.uploading > 0 ? <Spinner size={18} /> : ok ? <Check size={18} /> : <Camera size={18} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{slot.label}</span>
                <span className="block text-sm text-muted">
                  {st.uploading > 0 ? 'Uploading…' : ok ? `${pluralize(st.count, 'photo')} saved` : 'No photo yet'}
                </span>
                {st.error && <span className="block text-sm font-semibold text-danger">{st.error}</span>}
              </span>
              <Button
                size="sm"
                variant={ok ? 'ghost' : 'secondary'}
                icon={<Camera size={16} aria-hidden="true" />}
                aria-label={`${ok ? 'Add photo' : 'Take photo'}: ${slot.label}`}
                onClick={() => pick(slot, 'camera')}
              >
                {ok ? 'Add photo' : 'Take photo'}
              </Button>
              <IconButton label={`Choose from gallery: ${slot.label}`} onClick={() => pick(slot, 'gallery')}>
                <ImagePlus size={18} aria-hidden="true" />
              </IconButton>
            </li>
          );
        })}
      </ul>
      <p className="m-0 text-sm text-muted" aria-live="polite">
        {label}: {done} of {slots.length} done{uploads.total > done ? ` (${pluralize(uploads.total, 'photo')} in all)` : ''}.
        {uploads.busy ? ' Uploading…' : ''}
      </p>
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => onFiles(e.currentTarget)} />
      <input ref={galleryRef} type="file" accept="image/*" multiple hidden onChange={(e) => onFiles(e.currentTarget)} />
    </div>
  );
}
