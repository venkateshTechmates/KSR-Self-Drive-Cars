// Upload one or more files for a customer, booking, car or the business (DOC-01..04, DOC-10, DOC-11).
// On a phone, "Take photo" opens the camera directly (DOC-02).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, FileText, Upload, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import type { DocOwnerType } from '@shared/constants.ts';
import { ACCEPT_ATTR, formatBytes, looksLikeFullAadhaarNumber } from './docHelpers';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogFooter } from '@/components/ui/Dialog';
import { Alert, Checkbox, Field, Input, Select, Textarea } from '@/components/ui/Field';
import { uploadDocument } from '@/lib/documents';
import { errorMessage } from '@/lib/errors';
import type { DocumentRow, DocumentType } from '@/types/db';
import { useAuth } from '../../auth/AuthProvider';
import { qk, useDocumentTypes } from '../../hooks/queries';
import { RedactionTool } from './RedactionTool';

interface Props {
  open: boolean;
  onClose: () => void;
  ownerType: DocOwnerType;
  ownerId: string | null;
  /** Limit the type picker (e.g. ['pickup_photos']). */
  allowedTypes?: string[];
  defaultType?: string;
  /** Upload a new version of this document (DOC-11). */
  replaces?: DocumentRow | null;
  contextBookingId?: string | null;
  onUploaded?: (docs: DocumentRow[]) => void;
}

interface Picked {
  file: File;
  preview: string | null;
}

export function DocumentUploadDialog(props: Props) {
  const { data: allTypes = [] } = useDocumentTypes();
  const [busy, setBusy] = useState(false);
  const replacingLabel = allTypes.find((t) => t.key === props.replaces?.doc_type)?.label ?? '';
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      locked={busy}
      size="md"
      title={props.replaces ? `Upload a new version: ${replacingLabel}` : 'Upload documents'}
      description={props.replaces ? 'The current file is kept as history and marked Superseded.' : 'JPG, PNG, WebP, HEIC or PDF, up to 10 MB each.'}
    >
      <UploadForm {...props} busy={busy} setBusy={setBusy} />
    </Dialog>
  );
}

function UploadForm({
  onClose,
  ownerType,
  ownerId,
  allowedTypes,
  defaultType,
  replaces,
  contextBookingId,
  onUploaded,
  busy,
  setBusy,
}: Props & { busy: boolean; setBusy: (b: boolean) => void }) {
  const { role } = useAuth();
  const queryClient = useQueryClient();
  const { data: allTypes = [] } = useDocumentTypes();
  const types = useMemo(
    () =>
      allTypes.filter(
        (t) => t.active && t.owner_type === ownerType && role && t.view_roles.includes(role) && (!allowedTypes || allowedTypes.includes(t.key)),
      ),
    [allTypes, ownerType, role, allowedTypes],
  );

  const [docType, setDocType] = useState(replaces?.doc_type ?? defaultType ?? types[0]?.key ?? '');
  const [files, setFiles] = useState<Picked[]>([]);
  const [docNumber, setDocNumber] = useState('');
  const [issueDate, setIssueDate] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [notes, setNotes] = useState('');
  const [masked, setMasked] = useState(false);
  const [redacting, setRedacting] = useState<number | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<string | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);

  const previews = useRef<string[]>([]);
  useEffect(() => {
    const list = previews.current;
    return () => list.forEach((u) => URL.revokeObjectURL(u));
  }, []);
  const preview = (file: File) => {
    const url = URL.createObjectURL(file);
    previews.current.push(url);
    return url;
  };

  const effectiveType = docType || types[0]?.key || '';
  const type: DocumentType | undefined = types.find((t) => t.key === effectiveType) ?? allTypes.find((t) => t.key === effectiveType);
  const isAadhaar = effectiveType === 'aadhaar_masked';

  function addFiles(list: FileList | null) {
    if (!list?.length) return;
    const next = Array.from(list).map((file) => ({
      file,
      preview: file.type.startsWith('image/') && !/hei[cf]/i.test(file.type) ? preview(file) : null,
    }));
    setFiles((prev) => (replaces ? next.slice(0, 1) : [...prev, ...next]));
    setErrors((e) => ({ ...e, files: '' }));
  }

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!effectiveType) e.docType = 'Choose the document type.';
    if (!files.length) e.files = 'Add a photo or file.';
    if (type?.expiry_required && !expiryDate) e.expiryDate = 'Enter the expiry date.';
    if (issueDate && expiryDate && expiryDate < issueDate) e.expiryDate = 'The expiry date is before the issue date.';
    if (isAadhaar && !masked) e.masked = 'Confirm the Aadhaar number is masked, or use "Cover digits".';
    if (docNumber && (isAadhaar || effectiveType === 'other_photo_id') && looksLikeFullAadhaarNumber(docNumber)) {
      e.docNumber = "Don't enter a full Aadhaar number. Leave this blank.";
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function submit() {
    if (!validate()) return;
    setBusy(true);
    const uploaded: DocumentRow[] = [];
    try {
      for (let i = 0; i < files.length; i += 1) {
        setProgress(files.length > 1 ? `Uploading ${i + 1} of ${files.length}…` : 'Uploading…');
        const res = await uploadDocument({
          ownerType,
          ownerId,
          docType: effectiveType,
          file: files[i].file,
          docNumber: docNumber.trim() || undefined,
          issueDate: issueDate || undefined,
          expiryDate: expiryDate || undefined,
          notes: notes.trim() || undefined,
          replacesId: replaces?.id ?? null,
          aadhaarMaskedConfirmed: isAadhaar ? masked : undefined,
          contextBookingId: contextBookingId ?? null,
        });
        uploaded.push(res.document);
        if (res.duplicates.length) toast('The same file is also saved elsewhere. Check it is the right document.', { icon: '⚠️' });
      }
      toast.success(uploaded.length > 1 ? `${uploaded.length} files uploaded` : 'Uploaded');
      await queryClient.invalidateQueries({ queryKey: qk.documents });
      onUploaded?.(uploaded);
      onClose();
    } catch (err) {
      setErrors({ submit: `${errorMessage(err)}${uploaded.length ? ` (${uploaded.length} uploaded before the error.)` : ''}` });
      if (uploaded.length) void queryClient.invalidateQueries({ queryKey: qk.documents });
      setFiles((f) => f.slice(uploaded.length));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <>
      {redacting !== null ? (
        <RedactionTool
          file={files[redacting].file}
          onCancel={() => setRedacting(null)}
          onDone={(redacted) => {
            setFiles((list) => list.map((f, i) => (i === redacting ? { file: redacted, preview: preview(redacted) } : f)));
            setMasked(true);
            setRedacting(null);
          }}
        />
      ) : (
        <div className="flex flex-col gap-5">
          {!replaces && (
            <Field label="Document type" error={errors.docType}>
              <Select value={effectiveType} onChange={(e) => setDocType(e.target.value)}>
                {types.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <div className="flex flex-col gap-2">
            <span className="font-semibold">Files</span>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" icon={<Camera size={18} aria-hidden="true" />} onClick={() => cameraRef.current?.click()}>
                Take photo
              </Button>
              <Button variant="secondary" size="sm" icon={<Upload size={18} aria-hidden="true" />} onClick={() => pickerRef.current?.click()}>
                Choose {replaces ? 'a file' : 'files'}
              </Button>
              <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => (addFiles(e.target.files), (e.target.value = ''))} />
              <input
                ref={pickerRef}
                type="file"
                accept={ACCEPT_ATTR}
                multiple={!replaces}
                hidden
                onChange={(e) => (addFiles(e.target.files), (e.target.value = ''))}
              />
            </div>
            {errors.files && <p className="m-0 text-sm font-semibold text-danger">{errors.files}</p>}
            {files.length > 0 && (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {files.map((f, i) => (
                  <li key={`${f.file.name}-${i}`} className="flex items-center gap-3 rounded-xl border border-line-card bg-subtle p-2">
                    {f.preview ? (
                      <img src={f.preview} alt="" className="size-14 rounded-lg object-cover" />
                    ) : (
                      <span className="flex size-14 items-center justify-center rounded-lg bg-tile">
                        <FileText size={22} aria-hidden="true" />
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">{f.file.name}</span>
                      <span className="text-sm text-muted">{formatBytes(f.file.size)}</span>
                    </span>
                    {isAadhaar && f.file.type !== 'application/pdf' && (
                      <Button variant="ghost" size="sm" onClick={() => setRedacting(i)}>
                        Cover digits
                      </Button>
                    )}
                    <button
                      type="button"
                      className="inline-flex size-11 items-center justify-center rounded-full hover:bg-ink/5"
                      aria-label={`Remove ${f.file.name}`}
                      onClick={() => setFiles((list) => list.filter((_, j) => j !== i))}
                    >
                      <X size={18} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {isAadhaar && (
            <Alert tone="warning" title="Masked Aadhaar only">
              Only the last 4 digits may be visible. If the photo shows the full number, use <strong>Cover digits</strong> before uploading.
              The unmasked original is never saved.
            </Alert>
          )}
          {isAadhaar && (
            <Checkbox
              checked={masked}
              onChange={(e) => setMasked(e.target.checked)}
              error={errors.masked}
              label="I confirm only the last 4 digits of the Aadhaar number are visible in this file."
            />
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Document number" optional hint={isAadhaar ? 'Leave blank for Aadhaar.' : 'Stored masked: only the last 4 characters are shown.'} error={errors.docNumber}>
              <Input value={docNumber} onChange={(e) => setDocNumber(e.target.value)} autoComplete="off" disabled={isAadhaar} />
            </Field>
            <Field label="Issue date" optional>
              <Input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
            </Field>
            {(type?.tracks_expiry ?? true) && (
              <Field label="Expiry date" required={type?.expiry_required} optional={!type?.expiry_required} error={errors.expiryDate}>
                <Input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} />
              </Field>
            )}
          </div>
          <Field label="Notes" optional>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </Field>
          {errors.submit && <Alert>{errors.submit}</Alert>}
        </div>
      )}
      {redacting === null && (
        <DialogFooter>
          {progress && (
            <span className="mr-auto text-sm text-muted" role="status">
              {progress}
            </span>
          )}
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} loadingText="Uploading…" icon={<Upload size={18} aria-hidden="true" />}>
            Upload
          </Button>
        </DialogFooter>
      )}
    </>
  );
}
