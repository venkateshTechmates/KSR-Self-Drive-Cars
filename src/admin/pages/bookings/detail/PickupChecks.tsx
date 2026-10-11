// DOC-09 / AC-09: before the car is handed over the customer needs a verified licence valid past
// the return time and a verified identity. Each problem shows its fix; the Owner may override.
import { useState } from 'react';
import { CheckCircle2, ShieldAlert, ShieldCheck, Upload } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogFooter } from '@/components/ui/Dialog';
import { Alert, Field, Textarea } from '@/components/ui/Field';
import { Card, CardBody, CardHeader } from '@/components/ui/Layout';
import { Spinner } from '@/components/ui/Spinner';
import { errorMessage } from '@/lib/errors';
import type { AppRole } from '@shared/constants.ts';
import type { DocumentRow } from '@/types/db';
import { fixFor, type GateFix } from './helpers';

const FIX_LABEL: Record<GateFix['kind'], string> = {
  identity: 'Verify identity',
  verify_licence: 'Verify licence',
  upload_licence: 'Upload licence photo',
};

function FixButton({ fix, onFix }: { fix: GateFix; onFix: (f: GateFix) => void }) {
  const label = fix.kind === 'upload_licence' && fix.replaces ? 'Upload a new licence photo' : FIX_LABEL[fix.kind];
  return (
    <Button
      size="sm"
      variant="secondary"
      icon={fix.kind === 'upload_licence' ? <Upload size={16} aria-hidden="true" /> : <ShieldCheck size={16} aria-hidden="true" />}
      onClick={() => onFix(fix)}
    >
      {label}
    </Button>
  );
}

function ProblemList({
  problems,
  licence,
  canFix,
  onFix,
}: {
  problems: string[];
  licence: DocumentRow | undefined;
  canFix: boolean;
  onFix: (f: GateFix) => void;
}) {
  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
      {problems.map((p) => {
        const fix = canFix ? fixFor(p, licence) : null;
        return (
          <li key={p} className="flex flex-col gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 sm:flex-row sm:items-center sm:justify-between">
            <span className="flex items-start gap-2 text-amber-900">
              <ShieldAlert size={20} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>{p}</span>
            </span>
            {fix && <FixButton fix={fix} onFix={onFix} />}
          </li>
        );
      })}
    </ul>
  );
}

export function PickupChecksCard({
  problems,
  loading,
  error,
  licence,
  canFix,
  onFix,
}: {
  problems: string[] | undefined;
  loading: boolean;
  error: unknown;
  licence: DocumentRow | undefined;
  /** False when the customer record is hidden (Staff, not the day of the booking). */
  canFix: boolean;
  onFix: (f: GateFix) => void;
}) {
  return (
    <Card>
      <CardHeader title="Pickup checks" description="Licence and identity must be verified before the car is handed over." />
      <CardBody>
        <div aria-live="polite">
          {loading ? (
            <p className="m-0 flex items-center gap-2 text-muted">
              <Spinner size={18} /> Checking…
            </p>
          ) : error ? (
            <Alert>{errorMessage(error)}</Alert>
          ) : problems && problems.length > 0 ? (
            <>
              <ProblemList problems={problems} licence={licence} canFix={canFix} onFix={onFix} />
              {!canFix && <p className="m-0 mt-3 text-sm text-muted">You can fix these on the day of the booking.</p>}
            </>
          ) : (
            <p className="m-0 flex items-center gap-2 font-semibold text-emerald-800">
              <CheckCircle2 size={20} aria-hidden="true" /> All pickup checks passed. The car can be handed over.
            </p>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

/** AC-09: shown when "Mark picked up" is tapped while checks are still open. */
export function PickupGateDialog({
  open,
  onClose,
  problems,
  licence,
  canFix,
  role,
  onFix,
  onOverride,
}: {
  open: boolean;
  onClose: () => void;
  problems: string[];
  licence: DocumentRow | undefined;
  canFix: boolean;
  role: AppRole | null;
  onFix: (f: GateFix) => void;
  onOverride: (reason: string) => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} size="sm" title="Check these before pickup" description="The car can't be handed over until these are done.">
      <GateBody problems={problems} licence={licence} canFix={canFix} role={role} onFix={onFix} onOverride={onOverride} onClose={onClose} />
    </Dialog>
  );
}

function GateBody({
  problems,
  licence,
  canFix,
  role,
  onFix,
  onOverride,
  onClose,
}: {
  problems: string[];
  licence: DocumentRow | undefined;
  canFix: boolean;
  role: AppRole | null;
  onFix: (f: GateFix) => void;
  onOverride: (reason: string) => void;
  onClose: () => void;
}) {
  const [overriding, setOverriding] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <div className="flex flex-col gap-4">
        <ProblemList problems={problems} licence={licence} canFix={canFix} onFix={onFix} />
        {role === 'owner' && !overriding && (
          <p className="m-0 text-sm text-muted">As the Owner you can hand over anyway, with a reason that is kept in the audit log.</p>
        )}
        {role === 'owner' && overriding && (
          <Field label="Reason for handing over without these checks" required error={error}>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} autoFocus />
          </Field>
        )}
      </div>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          Back
        </Button>
        {role === 'owner' &&
          (overriding ? (
            <Button
              variant="danger"
              onClick={() => {
                if (!reason.trim()) return setError('Give a reason for the override.');
                onOverride(reason.trim());
              }}
            >
              Continue to handover
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => setOverriding(true)}>
              Override with reason
            </Button>
          ))}
      </DialogFooter>
    </>
  );
}
