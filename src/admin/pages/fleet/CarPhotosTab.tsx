// Photos tab (FLT-05, WEB-05): up to 8 photos per car, resized and converted to WebP in the
// browser (1600 / 800 / 400 px), stored in the public car-photos bucket. Alt text is required.
// Reorder by drag and drop, or with the move buttons (keyboard and touch).
import { useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, GripVertical, ImagePlus, Pencil, Star, Trash2, Upload } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { MAX_CAR_PHOTOS, MAX_UPLOAD_BYTES, formatBytes } from '@shared/documents.ts';
import { Badge } from '@/components/ui/Badges';
import { Button, IconButton } from '@/components/ui/Button';
import { ConfirmDialog, Dialog, DialogFooter } from '@/components/ui/Dialog';
import { Alert, Field, Input } from '@/components/ui/Field';
import { Card, CardBody, CardHeader, EmptyState } from '@/components/ui/Layout';
import { Spinner } from '@/components/ui/Spinner';
import { supabase } from '@/integrations/supabase/client';
import { carPhotoPaths, carPhotoSrcSet, carPhotoUrl } from '@/lib/carPhotos';
import { cn } from '@/lib/cn';
import { errorMessage, toAppError, unwrap } from '@/lib/errors';
import { prepareCarPhoto } from '@/lib/images';
import type { Car, CarPhoto } from '@/types/db';
import { useAuth } from '../../auth/AuthProvider';
import { qk } from '../../hooks/queries';
import { fleetKeys, photoFilePaths, useCarPhotos } from './fleetData';

const ACCEPT = '.jpg,.jpeg,.png,.webp,.heic,.heif,image/jpeg,image/png,image/webp,image/heic,image/heif';

interface PendingFile {
  key: string;
  file: File;
  preview: string | null;
}

const canPreview = (f: File) => /^image\/(jpeg|png|webp)$/.test(f.type);

export function CarPhotosTab({ car }: { car: Car }) {
  const queryClient = useQueryClient();
  const photos = useCarPhotos(car.id);
  const list = photos.data ?? [];
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<PendingFile[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pickMessage, setPickMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<CarPhoto | null>(null);
  const [deleting, setDeleting] = useState<CarPhoto | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);
  const [coverBusy, setCoverBusy] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');

  const remaining = Math.max(0, MAX_CAR_PHOTOS - list.length);
  const photosKey = fleetKeys.photos(car.id);
  const startOrder = list.length ? Math.max(...list.map((p) => p.sort_order)) + 1 : 0;

  function onPick(files: FileList | null) {
    if (!files?.length) return;
    const all = Array.from(files);
    const notes: string[] = [];
    const tooBig = all.filter((f) => f.size > MAX_UPLOAD_BYTES);
    if (tooBig.length) {
      notes.push(`${tooBig.map((f) => f.name).join(', ')} ${tooBig.length === 1 ? 'is' : 'are'} over 10 MB. Choose a smaller photo.`);
    }
    let ok = all.filter((f) => f.size <= MAX_UPLOAD_BYTES);
    if (ok.length > remaining) {
      notes.push(`A car can have up to ${MAX_CAR_PHOTOS} photos, so only the first ${remaining} ${remaining === 1 ? 'was' : 'were'} added.`);
      ok = ok.slice(0, remaining);
    }
    setPickMessage(notes.join(' ') || null);
    if (!ok.length) return;
    setPending(ok.map((file) => ({ key: crypto.randomUUID(), file, preview: canPreview(file) ? URL.createObjectURL(file) : null })));
  }

  function closePending() {
    pending?.forEach((p) => p.preview && URL.revokeObjectURL(p.preview));
    setPending(null);
  }

  async function saveOrder(next: CarPhoto[], movedId: string) {
    const renumbered = next.map((p, i) => ({ ...p, sort_order: i }));
    const changed = renumbered.filter((p) => list.find((o) => o.id === p.id)?.sort_order !== p.sort_order);
    if (!changed.length) return;
    const previous = queryClient.getQueryData<CarPhoto[]>(photosKey);
    queryClient.setQueryData(photosKey, renumbered);
    setSavingOrder(true);
    try {
      await Promise.all(
        changed.map((p) =>
          supabase
            .from('car_photos')
            .update({ sort_order: p.sort_order })
            .eq('id', p.id)
            .then((r) => unwrap(r)),
        ),
      );
      setAnnounce(`Photo moved to position ${renumbered.findIndex((p) => p.id === movedId) + 1} of ${renumbered.length}.`);
    } catch (err) {
      queryClient.setQueryData(photosKey, previous);
      toast.error(errorMessage(err));
    } finally {
      setSavingOrder(false);
      void queryClient.invalidateQueries({ queryKey: fleetKeys.photosAll });
    }
  }

  function reorder(fromId: string, toIndex: number) {
    const from = list.findIndex((p) => p.id === fromId);
    if (savingOrder || from < 0 || toIndex < 0 || toIndex >= list.length || from === toIndex) return null;
    const next = [...list];
    const [item] = next.splice(from, 1);
    next.splice(toIndex, 0, item);
    return saveOrder(next, fromId);
  }

  function move(photo: CarPhoto, dir: -1 | 1) {
    const index = list.findIndex((p) => p.id === photo.id);
    const done = reorder(photo.id, index + dir);
    void done?.then(() =>
      requestAnimationFrame(() => {
        const prefer = document.getElementById(`photo-${dir < 0 ? 'earlier' : 'later'}-${photo.id}`) as HTMLButtonElement | null;
        const other = document.getElementById(`photo-${dir < 0 ? 'later' : 'earlier'}-${photo.id}`) as HTMLButtonElement | null;
        (prefer && !prefer.disabled ? prefer : other)?.focus();
      }),
    );
  }

  async function makeCover(photo: CarPhoto) {
    setCoverBusy(photo.id);
    try {
      unwrap(await supabase.from('cars').update({ cover_photo_id: photo.id }).eq('id', car.id).select('id').single());
      await queryClient.invalidateQueries({ queryKey: qk.cars });
      toast.success('Cover photo set');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setCoverBusy(null);
    }
  }

  async function remove(photo: CarPhoto) {
    if (car.cover_photo_id === photo.id) {
      unwrap(await supabase.from('cars').update({ cover_photo_id: null }).eq('id', car.id).select('id').single());
    }
    const { error } = await supabase.storage.from('car-photos').remove(photoFilePaths(photo));
    if (error) throw toAppError(error);
    unwrap(await supabase.from('car_photos').delete().eq('id', photo.id).select('id'));
    await queryClient.invalidateQueries({ queryKey: qk.cars });
    toast.success('Photo deleted');
  }

  return (
    <Card>
      <CardHeader
        title="Photos"
        description={`${list.length} of ${MAX_CAR_PHOTOS}. The cover photo shows first on the website.`}
        actions={
          <>
            <Button
              size="sm"
              icon={<ImagePlus size={18} aria-hidden="true" />}
              onClick={() => inputRef.current?.click()}
              disabled={remaining === 0 || photos.isLoading}
            >
              Add photos
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              multiple
              hidden
              onChange={(e) => {
                onPick(e.target.files);
                e.target.value = '';
              }}
            />
          </>
        }
      />
      <CardBody className="flex flex-col gap-4">
        <p className="sr-only" role="status" aria-live="polite">
          {announce}
        </p>
        {remaining === 0 && <Alert tone="info">This car has {MAX_CAR_PHOTOS} photos, the most allowed. Delete one to add another.</Alert>}
        {pickMessage && <Alert tone="warning">{pickMessage}</Alert>}
        {photos.isLoading ? (
          <div className="flex justify-center p-6">
            <Spinner label="Loading photos" />
          </div>
        ) : photos.error ? (
          <Alert title="Couldn't load the photos">{errorMessage(photos.error)}</Alert>
        ) : list.length === 0 ? (
          <EmptyState
            title="No photos yet"
            action={
              <Button size="sm" icon={<ImagePlus size={18} aria-hidden="true" />} onClick={() => inputRef.current?.click()}>
                Add photos
              </Button>
            }
          >
            The website shows an outline drawing until you add photos. JPG, PNG, WebP or HEIC, up to 10 MB each.
          </EmptyState>
        ) : (
          <>
            <p className="m-0 text-sm text-muted">Drag photos to reorder them, or use the arrow buttons.</p>
            <ol className="m-0 grid list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3">
              {list.map((p, i) => {
                const isCover = car.cover_photo_id === p.id;
                return (
                  <li
                    key={p.id}
                    draggable={!savingOrder}
                    onDragStart={(e) => {
                      setDragId(p.id);
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', p.id);
                    }}
                    onDragOver={(e) => {
                      if (!dragId) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      if (overId !== p.id) setOverId(p.id);
                    }}
                    onDragLeave={() => setOverId((o) => (o === p.id ? null : o))}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragId) void reorder(dragId, i);
                      setDragId(null);
                      setOverId(null);
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setOverId(null);
                    }}
                    className={cn(
                      'flex flex-col overflow-hidden rounded-2xl border bg-surface',
                      overId === p.id && dragId !== p.id ? 'border-ink ring-2 ring-ink' : 'border-line-card',
                      dragId === p.id && 'opacity-50',
                    )}
                  >
                    <div className="relative aspect-[4/3] cursor-grab bg-tile active:cursor-grabbing">
                      <img
                        src={carPhotoUrl(p.storage_path, 400)}
                        srcSet={carPhotoSrcSet(p.storage_path)}
                        sizes="(min-width: 1024px) 320px, (min-width: 640px) 45vw, 100vw"
                        width={p.width}
                        height={p.height}
                        alt={p.alt_text}
                        loading="lazy"
                        decoding="async"
                        draggable={false}
                        className="h-full w-full object-cover"
                      />
                      <span className="absolute top-2 left-2 flex gap-1">
                        <Badge tone="dark">
                          {i + 1} of {list.length}
                        </Badge>
                        {isCover && (
                          <Badge tone="amber">
                            <Star size={12} aria-hidden="true" /> Cover
                          </Badge>
                        )}
                      </span>
                      <span className="absolute top-2 right-2 hidden rounded-full bg-white/90 p-1.5 text-ink sm:block" aria-hidden="true">
                        <GripVertical size={18} />
                      </span>
                    </div>
                    <div className="flex flex-1 flex-col gap-3 p-3">
                      <p className="m-0 text-sm break-words">
                        <span className="text-muted">Alt text: </span>
                        {p.alt_text}
                      </p>
                      <div className="mt-auto flex flex-wrap items-center gap-1">
                        <IconButton
                          id={`photo-earlier-${p.id}`}
                          label={`Move photo ${i + 1} earlier`}
                          disabled={i === 0}
                          onClick={() => move(p, -1)}
                          className="border border-line-input"
                        >
                          <ArrowLeft size={18} aria-hidden="true" />
                        </IconButton>
                        <IconButton
                          id={`photo-later-${p.id}`}
                          label={`Move photo ${i + 1} later`}
                          disabled={i === list.length - 1}
                          onClick={() => move(p, 1)}
                          className="border border-line-input"
                        >
                          <ArrowRight size={18} aria-hidden="true" />
                        </IconButton>
                        {!isCover && (
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={<Star size={16} aria-hidden="true" />}
                            loading={coverBusy === p.id}
                            onClick={() => void makeCover(p)}
                            aria-label={`Make cover: photo ${i + 1}`}
                          >
                            Make cover
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={<Pencil size={16} aria-hidden="true" />}
                          onClick={() => setEditing(p)}
                          aria-label={`Edit alt text of photo ${i + 1}`}
                        >
                          Alt text
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={<Trash2 size={16} aria-hidden="true" />}
                          onClick={() => setDeleting(p)}
                          aria-label={`Delete photo ${i + 1}`}
                        >
                          Delete
                        </Button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </CardBody>

      <Dialog
        open={Boolean(pending)}
        onClose={closePending}
        locked={uploading}
        size="lg"
        title={`Add photos of ${car.display_name}`}
        description="Photos are resized and saved as WebP. Location data is removed."
      >
        {pending && <UploadPhotosForm car={car} files={pending} startOrder={startOrder} setBusy={setUploading} onClose={closePending} />}
      </Dialog>

      <Dialog open={Boolean(editing)} onClose={() => setEditing(null)} size="sm" title="Edit alt text" description="Screen readers read it out, and it shows if the photo can't load.">
        {editing && <AltTextForm key={editing.id} photo={editing} onClose={() => setEditing(null)} />}
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title="Delete this photo?"
        description={deleting && car.cover_photo_id === deleting.id ? 'It is the cover photo. Choose a new cover afterwards.' : "This can't be undone."}
        confirmLabel="Delete photo"
        tone="danger"
        onConfirm={() => remove(deleting!)}
      />
    </Card>
  );
}

type ItemState = { state: 'working' | 'done' | 'error'; message: string };

function UploadPhotosForm({
  car,
  files,
  startOrder,
  setBusy,
  onClose,
}: {
  car: Car;
  files: PendingFile[];
  startOrder: number;
  setBusy: (b: boolean) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const [alts, setAlts] = useState<Record<string, string>>(() => Object.fromEntries(files.map((f) => [f.key, `${car.display_name}, side view`])));
  const [status, setStatus] = useState<Record<string, ItemState>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  const isDone = (key: string) => status[key]?.state === 'done';
  const todo = files.filter((f) => !isDone(f.key));
  const doneCount = files.length - todo.length;
  const setItem = (key: string, s: ItemState) => setStatus((prev) => ({ ...prev, [key]: s }));

  async function submit() {
    const errs: Record<string, string> = {};
    for (const f of todo) {
      const alt = (alts[f.key] ?? '').trim();
      if (alt.length < 3) errs[f.key] = 'Describe the photo in a few words, for example "Kia Sonet, front view".';
      else if (alt.length > 200) errs[f.key] = 'Keep the alt text to 200 characters or fewer.';
    }
    setErrors(errs);
    const firstBad = todo.find((f) => errs[f.key]);
    if (firstBad) {
      document.getElementById(`alt-${firstBad.key}`)?.focus();
      return;
    }

    setRunning(true);
    setBusy(true);
    setSummary(null);
    let order = startOrder + doneCount;
    let firstId: string | null = null;
    let saved = 0;
    let failed = 0;
    for (const [n, f] of todo.entries()) {
      setProgress(`Saving ${n + 1} of ${todo.length}…`);
      setItem(f.key, { state: 'working', message: 'Resizing…' });
      try {
        const variants = await prepareCarPhoto(f.file);
        const id = crypto.randomUUID();
        const paths = carPhotoPaths(car.id, id);
        setItem(f.key, { state: 'working', message: 'Uploading…' });
        const uploaded: string[] = [];
        try {
          const parts: Array<[string, Blob]> = [
            [paths.full, variants.full],
            [paths.medium, variants.medium],
            [paths.small, variants.small],
          ];
          for (const [path, blob] of parts) {
            unwrap(await supabase.storage.from('car-photos').upload(path, blob, { contentType: 'image/webp', upsert: false, cacheControl: '31536000' }));
            uploaded.push(path);
          }
          unwrap(
            await supabase
              .from('car_photos')
              .insert({
                id,
                car_id: car.id,
                storage_path: paths.full,
                alt_text: alts[f.key].trim(),
                sort_order: order,
                width: variants.width,
                height: variants.height,
                created_by: session?.user.id ?? null,
              })
              .select('id')
              .single(),
          );
        } catch (err) {
          // Don't leave orphan files behind when the row can't be saved.
          if (uploaded.length) await supabase.storage.from('car-photos').remove(uploaded);
          throw err;
        }
        order += 1;
        saved += 1;
        firstId ??= id;
        setItem(f.key, { state: 'done', message: 'Saved' });
      } catch (err) {
        failed += 1;
        setItem(f.key, { state: 'error', message: errorMessage(err) });
      }
    }
    if (firstId && !car.cover_photo_id) {
      try {
        unwrap(await supabase.from('cars').update({ cover_photo_id: firstId }).eq('id', car.id).select('id').single());
      } catch {
        // The cover can be chosen later.
      }
    }
    await queryClient.invalidateQueries({ queryKey: qk.cars });
    setRunning(false);
    setBusy(false);
    setProgress(null);
    if (failed === 0) {
      toast.success(saved === 1 ? 'Photo added' : `${saved} photos added`);
      onClose();
    } else {
      setSummary(`${saved} saved, ${failed} not saved. Check the messages below, then try again or close.`);
    }
  }

  return (
    <>
      <div className="flex flex-col gap-4">
        {summary && <Alert tone="warning">{summary}</Alert>}
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {files.map((f, i) => {
            const s = status[f.key];
            const done = s?.state === 'done';
            return (
              <li key={f.key} className="flex flex-col gap-3 rounded-xl border border-line-card bg-subtle p-3 sm:flex-row">
                {f.preview ? (
                  <img src={f.preview} alt="" className="h-24 w-32 shrink-0 rounded-lg object-cover" />
                ) : (
                  <span className="flex h-24 w-32 shrink-0 items-center justify-center rounded-lg bg-tile px-2 text-center text-sm text-muted">
                    Preview after upload
                  </span>
                )}
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <p className="m-0 truncate text-sm font-semibold">
                    {f.file.name} · {formatBytes(f.file.size)}
                  </p>
                  <Field label={`Alt text for photo ${i + 1}`} required error={errors[f.key]} hint="Say what the photo shows, for example the side or the interior.">
                    <Input
                      id={`alt-${f.key}`}
                      value={alts[f.key] ?? ''}
                      onChange={(e) => setAlts((a) => ({ ...a, [f.key]: e.target.value }))}
                      disabled={running || done}
                      maxLength={200}
                      autoComplete="off"
                    />
                  </Field>
                  {s && (
                    <p
                      className={cn(
                        'm-0 flex items-center gap-2 text-sm font-semibold',
                        s.state === 'error' ? 'text-danger' : s.state === 'done' ? 'text-emerald-800' : 'text-muted',
                      )}
                    >
                      {s.state === 'working' && <Spinner size={14} />}
                      {s.message}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      <DialogFooter>
        {progress && (
          <span className="mr-auto text-sm text-muted" role="status">
            {progress}
          </span>
        )}
        <Button variant="secondary" onClick={onClose} disabled={running}>
          {doneCount > 0 ? 'Close' : 'Cancel'}
        </Button>
        {todo.length > 0 && (
          <Button onClick={() => void submit()} loading={running} loadingText="Saving…" icon={<Upload size={18} aria-hidden="true" />}>
            {todo.length === 1 ? 'Upload photo' : `Upload ${todo.length} photos`}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

function AltTextForm({ photo, onClose }: { photo: CarPhoto; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [alt, setAlt] = useState(photo.alt_text);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    const value = alt.trim();
    if (value.length < 3 || value.length > 200) {
      setError('Describe the photo in 3 to 200 characters, for example "Kia Sonet, front view".');
      return;
    }
    setSaving(true);
    try {
      unwrap(await supabase.from('car_photos').update({ alt_text: value }).eq('id', photo.id).select('id').single());
      await queryClient.invalidateQueries({ queryKey: qk.cars });
      toast.success('Alt text saved');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Field label="Alt text" required error={error}>
        <Input value={alt} onChange={(e) => setAlt(e.target.value)} maxLength={200} autoFocus autoComplete="off" />
      </Field>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={() => void save()} loading={saving}>
          Save
        </Button>
      </DialogFooter>
    </>
  );
}
