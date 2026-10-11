// Customer self-upload (DOC-16): a one-time link (24 hours) for licence photos and a masked
// Aadhaar before pickup. Files arrive as Pending for staff to verify.
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Camera, FileText, Upload, X } from 'lucide-react';
import { formatDateTime } from '@shared/time.ts';
import { RedactionTool } from '@/admin/components/documents/RedactionTool';
import { Button } from '@/components/ui/Button';
import { Alert, Checkbox } from '@/components/ui/Field';
import { PageSpinner } from '@/components/ui/Spinner';
import { AppError, errorMessage } from '@/lib/errors';
import { callFunction } from '@/lib/functions';
import { prepareDocumentFile } from '@/lib/images';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { SitePage } from '../components/SiteChrome';

interface LinkInfo {
  valid: boolean;
  first_name: string;
  expires_at: string;
  business_name: string;
  doc_types: Array<{ key: string; label: string }>;
}

const HINTS: Record<string, string> = {
  dl_front: 'The side with your photo.',
  dl_back: 'The side with the vehicle classes.',
  aadhaar_masked: 'Only the last 4 digits may be visible. Cover the rest before uploading.',
  other_photo_id: 'Passport or voter ID, if you prefer not to share Aadhaar.',
};

export default function CustomerUploadPage() {
  const { token = '' } = useParams();
  useDocumentMeta({ title: 'Upload your documents | KSR Self Drive Cars', noindex: true });
  const info = useQuery({
    queryKey: ['upload-link', token],
    queryFn: () => callFunction<LinkInfo>('customer-upload', { method: 'GET', query: { token }, anonymous: true }),
    retry: false,
  });

  return (
    <SitePage>
      <div className="mx-auto max-w-[640px] px-5 py-10 sm:px-6 md:py-14">
        <h1 className="display m-0 text-[44px] md:text-[56px]">Upload your documents</h1>
        {info.isLoading && <PageSpinner />}
        {info.error && (
          <Alert className="mt-6" title="This link can't be used">
            {errorMessage(info.error)}
          </Alert>
        )}
        {info.data && <UploadForm token={token} info={info.data} />}
      </div>
    </SitePage>
  );
}

function UploadForm({ token, info }: { token: string; info: LinkInfo }) {
  const [files, setFiles] = useState<Record<string, File | undefined>>({});
  const [masked, setMasked] = useState(false);
  const [consent, setConsent] = useState(false);
  const [redacting, setRedacting] = useState<File | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number | null>(null);

  if (done !== null) {
    return (
      <Alert tone="success" className="mt-6" title="Thank you, we have your documents">
        {done} file{done === 1 ? '' : 's'} uploaded. Bring the originals to the pickup; we&apos;ll check them before handing over the keys.
      </Alert>
    );
  }

  if (redacting) {
    return (
      <div className="mt-6">
        <RedactionTool
          file={redacting}
          onCancel={() => setRedacting(null)}
          onDone={(f) => {
            setFiles((s) => ({ ...s, aadhaar_masked: f }));
            setMasked(true);
            setRedacting(null);
          }}
        />
      </div>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    const chosen = Object.entries(files).filter(([, f]) => f) as Array<[string, File]>;
    if (!chosen.length) next.form = 'Add at least one photo.';
    if (files.aadhaar_masked && !masked) next.masked = 'Confirm the Aadhaar number is covered except the last 4 digits.';
    if (!consent) next.consent = 'Tick the box to agree to how we use these documents.';
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.set('token', token);
      form.set('consent', 'true');
      if (files.aadhaar_masked) form.set('aadhaar_masked_confirmed', 'true');
      for (const [key, file] of chosen) {
        const prepared = key === 'aadhaar_masked' && file.name.endsWith('-masked.jpg') ? { blob: file, name: file.name } : await prepareDocumentFile(file);
        form.set(`file_${key}`, prepared.blob, prepared.name);
      }
      const res = await callFunction<{ ok: boolean; uploaded: number }>('customer-upload', { formData: form, anonymous: true });
      setDone(res.uploaded);
    } catch (err) {
      if (err instanceof AppError && err.hint && typeof err.hint === 'object') {
        setErrors({ ...(err.hint as Record<string, string>), form: err.message });
      } else setErrors({ form: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="mt-6 flex flex-col gap-6">
      <p className="m-0 text-lg text-ink-2">
        Hi {info.first_name}, add photos of your documents so your pickup is quicker. This link works until {formatDateTime(info.expires_at)}.
      </p>
      {info.doc_types.map((t) => (
        <FilePick
          key={t.key}
          label={t.label}
          hint={HINTS[t.key]}
          file={files[t.key]}
          error={errors[`file_${t.key}`]}
          onPick={(f) => {
            setFiles((s) => ({ ...s, [t.key]: f }));
            if (t.key === 'aadhaar_masked') setMasked(false);
          }}
          extra={
            t.key === 'aadhaar_masked' && files.aadhaar_masked && !files.aadhaar_masked.name.endsWith('-masked.jpg') && files.aadhaar_masked.type !== 'application/pdf' ? (
              <Button variant="secondary" size="sm" onClick={() => setRedacting(files.aadhaar_masked!)}>
                Cover the digits
              </Button>
            ) : null
          }
        />
      ))}
      {files.aadhaar_masked && (
        <Checkbox
          checked={masked}
          onChange={(e) => setMasked(e.target.checked)}
          error={errors.masked}
          label="Only the last 4 digits of my Aadhaar number are visible in this photo."
        />
      )}
      <Checkbox
        checked={consent}
        onChange={(e) => setConsent(e.target.checked)}
        error={errors.consent}
        label={
          <>
            I agree that {info.business_name || 'KSR Self Drive Cars'} can keep these documents to verify my identity and licence for my rental, and
            handle any fines or damage linked to it.{' '}
            <Link to="/privacy" target="_blank" rel="noopener">
              Read the privacy notice
            </Link>
          </>
        }
      />
      {errors.form && <Alert>{errors.form}</Alert>}
      <Button type="submit" size="lg" loading={busy} loadingText="Uploading…" icon={<Upload size={18} aria-hidden="true" />} className="self-start">
        Upload documents
      </Button>
    </form>
  );
}

function FilePick({
  label,
  hint,
  file,
  error,
  onPick,
  extra,
}: {
  label: string;
  hint?: string;
  file?: File;
  error?: string;
  onPick: (f: File | undefined) => void;
  extra?: ReactNode;
}) {
  const camera = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  return (
    <fieldset className="m-0 flex flex-col gap-2 rounded-2xl border border-line-card bg-white p-4">
      <legend className="sr-only">{label}</legend>
      <p className="m-0 font-semibold" aria-hidden="true">
        {label}
      </p>
      {hint && <p className="m-0 text-sm text-muted">{hint}</p>}
      {file ? (
        <div className="flex items-center gap-3 rounded-xl bg-subtle p-2">
          <FileText size={20} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{file.name}</span>
          {extra}
          <button type="button" aria-label={`Remove ${label}`} onClick={() => onPick(undefined)} className="inline-flex size-11 items-center justify-center rounded-full hover:bg-ink/5">
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" icon={<Camera size={18} aria-hidden="true" />} onClick={() => camera.current?.click()}>
            Take photo
          </Button>
          <Button variant="secondary" size="sm" icon={<Upload size={18} aria-hidden="true" />} onClick={() => picker.current?.click()}>
            Choose file
          </Button>
        </div>
      )}
      <input ref={camera} type="file" accept="image/*" capture="environment" hidden aria-label={`${label}: take photo`} onChange={(e) => onPick(e.target.files?.[0])} />
      <input ref={picker} type="file" accept="image/*,application/pdf" hidden aria-label={`${label}: choose file`} onChange={(e) => onPick(e.target.files?.[0])} />
      {error && <p className="m-0 text-sm font-semibold text-danger">{error}</p>}
    </fieldset>
  );
}
