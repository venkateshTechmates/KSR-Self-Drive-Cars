// Notification recipients (SET-07). Empty lists fall back to every active Owner and Manager
// (lockouts: Owners only), so alerts are never sent to nobody.
import { useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import toast from 'react-hot-toast';
import { X } from 'lucide-react';
import type { NotificationSettings } from '@shared/settings.ts';
import { validateEmail } from '@shared/validation.ts';
import { Button } from '@/components/ui/Button';
import { Alert, controlClass } from '@/components/ui/Field';
import { errorMessage } from '@/lib/errors';
import { useSaveSetting, useSetting } from '../../hooks/queries';
import { FormCard, Loader, SaveBar } from './FormParts';
import { sameJson } from './formUtils';

type Key = keyof NotificationSettings;

const LISTS: Array<{ key: Key; label: string; hint: string; fallback: string }> = [
  { key: 'new_request_emails', label: 'New booking requests', hint: 'An email for every request from the website.', fallback: 'Owners and Managers' },
  { key: 'flagged_emails', label: 'Flagged bookings', hint: 'Clash, blocked customer or licence expiry.', fallback: 'Owners and Managers' },
  { key: 'expiry_emails', label: 'Vehicle papers expiring', hint: '30, 15, 7 and 1 day before, and on the day.', fallback: 'Owners and Managers' },
  { key: 'overdue_emails', label: 'Overdue returns', hint: 'When an active booking passes its return time.', fallback: 'Owners and Managers' },
  { key: 'upload_emails', label: 'Customer uploaded documents', hint: 'When a customer uses an upload link.', fallback: 'Owners and Managers' },
  { key: 'lockout_emails', label: 'Account lockouts', hint: 'After 5 failed sign-ins on a staff account.', fallback: 'Owners' },
];

const MAX_RECIPIENTS = 10;

export function NotificationsTab() {
  const query = useSetting('notifications');
  return <Loader query={query}>{(data) => <NotificationsForm key={query.dataUpdatedAt} initial={data} />}</Loader>;
}

function NotificationsForm({ initial }: { initial: NotificationSettings }) {
  const save = useSaveSetting('notifications');
  const [form, setForm] = useState<NotificationSettings>(initial);
  const dirty = !sameJson(form, initial);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await save.mutateAsync(form);
      toast.success('Notification settings saved.');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      <Alert tone="info">
        Leave a list empty to email every active Owner and Manager (account lockouts go to Owners only). Add addresses to send to specific people
        instead.
      </Alert>
      <FormCard title="Who gets which emails">
        <div className="flex flex-col gap-5">
          {LISTS.map((l) => (
            <EmailChips
              key={l.key}
              label={l.label}
              hint={l.hint}
              fallback={l.fallback}
              value={form[l.key]}
              onChange={(next) => setForm((f) => ({ ...f, [l.key]: next }))}
            />
          ))}
        </div>
      </FormCard>
      <SaveBar dirty={dirty} saving={save.isPending} />
    </form>
  );
}

/** Email addresses as removable chips. Enter, comma or leaving the box adds the typed address. */
function EmailChips({
  label,
  hint,
  fallback,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  fallback: string;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  function add(): boolean {
    const parts = draft
      .split(/[,;\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (parts.length === 0) return true;
    const next = [...value];
    for (const email of parts) {
      const err = validateEmail(email);
      if (err) {
        setError(`“${email}” isn't a valid email address. Check it and try again.`);
        return false;
      }
      if (!next.includes(email)) next.push(email);
    }
    if (next.length > MAX_RECIPIENTS) {
      setError(`Add up to ${MAX_RECIPIENTS} addresses.`);
      return false;
    }
    onChange(next);
    setDraft('');
    setError(null);
    return true;
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add();
    } else if (e.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  }

  return (
    <div className="flex flex-col gap-2 border-b border-line-card pb-5 last:border-0 last:pb-0">
      <label htmlFor={id} className="font-semibold">
        {label}
      </label>
      <p id={`${id}-hint`} className="m-0 text-sm text-muted">
        {hint} {value.length === 0 && <>Now going to: all {fallback}.</>}
      </p>
      {value.length > 0 && (
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label={`${label} recipients`}>
          {value.map((email) => (
            <li key={email} className="inline-flex min-h-11 items-center gap-1 rounded-full border border-line-input bg-subtle pr-1 pl-3 text-[15px]">
              <span className="break-all">{email}</span>
              <button
                type="button"
                aria-label={`Remove ${email}`}
                onClick={() => onChange(value.filter((v) => v !== email))}
                className="inline-flex size-9 items-center justify-center rounded-full hover:bg-ink/10"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <input
          id={id}
          type="email"
          inputMode="email"
          autoComplete="off"
          value={draft}
          placeholder="name@example.com"
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            if (draft.trim()) add();
          }}
          aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
          aria-invalid={error ? true : undefined}
          className={controlClass(Boolean(error), 'min-w-0 flex-1 sm:max-w-sm')}
        />
        <Button variant="secondary" onClick={() => add()}>
          Add
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
