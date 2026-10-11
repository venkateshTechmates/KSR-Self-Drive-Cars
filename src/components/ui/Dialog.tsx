import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button, IconButton } from './Button';
import { Field, Textarea } from './Field';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** Full-screen sheet on phones, centred modal on wider screens. */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  /** Prevent closing with Escape / backdrop (e.g. while saving). */
  locked?: boolean;
}

const widths = { sm: 'sm:max-w-md', md: 'sm:max-w-xl', lg: 'sm:max-w-3xl', xl: 'sm:max-w-5xl' } as const;

/**
 * Accessible modal built on the native <dialog> element (focus trap and Escape for free).
 * Children mount only while open, so keep form state in a child component rendered inside
 * <Dialog>: it resets on every open without effects. Such children can render their own
 * buttons with <DialogFooter>, which sticks to the bottom of the dialog.
 */
export function Dialog({ open, onClose, title, description, children, footer, size = 'md', className, locked }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        if (!locked) onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !locked) onClose();
      }}
      className={cn(
        'm-0 h-dvh max-h-dvh w-full max-w-none bg-surface p-0 text-ink',
        'sm:m-auto sm:h-auto sm:max-h-[90dvh] sm:rounded-2xl sm:shadow-2xl',
        widths[size],
        className,
      )}
    >
      {open && (
        <div className="flex h-full max-h-dvh flex-col sm:max-h-[90dvh]">
          <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <h2 id={titleId} className="m-0 text-xl font-bold leading-tight">
                {title}
              </h2>
              {description && (
                <p id={descId} className="m-0 mt-1 text-[15px] text-muted">
                  {description}
                </p>
              )}
            </div>
            <IconButton label="Close" onClick={onClose} disabled={locked} className="-mr-2 -mt-1">
              <X size={20} aria-hidden="true" />
            </IconButton>
          </header>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pt-5 pb-5 [&:has(>[data-dialog-footer]:last-child)]:pb-0">{children}</div>
          {footer && (
            <footer className="flex flex-wrap items-center justify-end gap-3 border-t border-line bg-subtle px-5 py-3">{footer}</footer>
          )}
        </div>
      )}
    </dialog>
  );
}

/** Buttons row for stateful dialog bodies; sticks to the bottom of the scroll area. */
export function DialogFooter({ children }: { children: ReactNode }) {
  return (
    <div
      data-dialog-footer=""
      className="sticky bottom-0 -mx-5 mt-5 flex flex-wrap items-center justify-end gap-3 border-t border-line bg-subtle px-5 py-3"
    >
      {children}
    </div>
  );
}

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<unknown> | unknown;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  /** Ask for a reason (required unless reasonOptional). */
  reasonLabel?: string;
  reasonOptional?: boolean;
  reasonHint?: ReactNode;
  children?: ReactNode;
}

/** Confirmation with an optional "reason" box (reject, cancel, override, delete…). */
export function ConfirmDialog(props: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={props.open} onClose={props.onClose} title={props.title} description={props.description} size="sm" locked={busy}>
      <ConfirmBody {...props} busy={busy} setBusy={setBusy} />
    </Dialog>
  );
}

function ConfirmBody({
  onClose,
  onConfirm,
  confirmLabel,
  tone = 'primary',
  reasonLabel,
  reasonOptional,
  reasonHint,
  children,
  busy,
  setBusy,
}: ConfirmDialogProps & { busy: boolean; setBusy: (b: boolean) => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (reasonLabel && !reasonOptional && !reason.trim()) {
      setError('Give a reason.');
      return;
    }
    setBusy(true);
    try {
      await onConfirm(reason.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex flex-col gap-4">
        {children}
        {reasonLabel && (
          <Field label={reasonLabel} error={error} hint={reasonHint} optional={reasonOptional}>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} autoFocus />
          </Field>
        )}
        {!reasonLabel && error && (
          <p role="alert" className="m-0 font-semibold text-danger">
            {error}
          </p>
        )}
      </div>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Back
        </Button>
        <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={submit} loading={busy}>
          {confirmLabel}
        </Button>
      </DialogFooter>
    </>
  );
}
