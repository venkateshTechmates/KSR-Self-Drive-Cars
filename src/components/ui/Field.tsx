import {
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '@/lib/cn';

export const controlClass = (invalid?: boolean, extra?: string) =>
  cn(
    'block w-full min-h-[52px] rounded-xl border bg-white px-3.5 text-[16px] text-ink placeholder:text-muted/70',
    'disabled:bg-subtle disabled:text-muted',
    invalid ? 'border-danger ring-1 ring-danger' : 'border-line-input',
    extra,
  );

interface FieldProps {
  label: ReactNode;
  children: ReactElement<{ id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }>;
  error?: string | null;
  hint?: ReactNode;
  required?: boolean;
  optional?: boolean;
  className?: string;
  /** Visually hide the label (it stays available to screen readers). */
  hideLabel?: boolean;
}

/** Label + control + hint + error, wired with aria-describedby (WCAG 2.1 AA). */
export function Field({ label, children, error, hint, required, optional, className, hideLabel }: FieldProps) {
  const autoId = useId();
  const id = (isValidElement(children) && children.props.id) || autoId;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const own = isValidElement(children) ? children.props['aria-describedby'] : undefined;
  const describedBy = [own, hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)}>
      <label htmlFor={id} className={cn('font-semibold', hideLabel && 'sr-only')}>
        {label}
        {required && (
          <span aria-hidden="true" className="text-danger">
            {' '}
            *
          </span>
        )}
        {optional && <span className="font-normal text-muted"> (optional)</span>}
      </label>
      {cloneElement(children, { id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {hint && (
        <p id={hintId} className="m-0 text-sm text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="m-0 text-sm font-semibold text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  function Input({ className, invalid, ...rest }, ref) {
    return <input ref={ref} className={controlClass(invalid || rest['aria-invalid'] === true, className)} {...rest} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }>(
  function Select({ className, invalid, children, ...rest }, ref) {
    return (
      <select ref={ref} className={controlClass(invalid || rest['aria-invalid'] === true, cn('pr-8', className))} {...rest}>
        {children}
      </select>
    );
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(
  function Textarea({ className, invalid, rows = 3, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        rows={rows}
        className={controlClass(invalid || rest['aria-invalid'] === true, cn('min-h-0 py-3 leading-normal', className))}
        {...rest}
      />
    );
  },
);

interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode;
  error?: string | null;
  description?: ReactNode;
}

export function Checkbox({ label, error, description, className, id, ...rest }: CheckboxProps) {
  const autoId = useId();
  const cid = id ?? autoId;
  const errorId = error ? `${cid}-error` : undefined;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={cid} className="flex min-h-11 cursor-pointer items-start gap-3 py-1">
        <input
          id={cid}
          type="checkbox"
          className="mt-0.5 size-5 shrink-0 accent-ink"
          aria-invalid={error ? true : undefined}
          aria-describedby={errorId}
          {...rest}
        />
        <span className="leading-snug">
          {label}
          {description && <span className="mt-1 block text-sm text-muted">{description}</span>}
        </span>
      </label>
      {error && (
        <p id={errorId} className="m-0 text-sm font-semibold text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** Inline message box for errors, warnings and notes. */
export function Alert({
  tone = 'error',
  title,
  children,
  className,
}: {
  tone?: 'error' | 'warning' | 'info' | 'success';
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const tones = {
    error: 'bg-danger-bg text-danger border-danger/30',
    warning: 'bg-amber-50 text-amber-900 border-amber-300',
    info: 'bg-subtle text-ink-2 border-line',
    success: 'bg-emerald-50 text-emerald-900 border-emerald-300',
  } as const;
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cn('rounded-xl border px-4 py-3', tones[tone], className)}>
      {title && <p className="m-0 font-semibold">{title}</p>}
      {children && <div className={cn('text-[15px]', title ? 'mt-1' : undefined)}>{children}</div>}
    </div>
  );
}
