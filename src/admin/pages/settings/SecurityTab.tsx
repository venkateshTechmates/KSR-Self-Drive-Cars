// Security (ADM-03, ADM-05): which roles must use two-step verification, the session limit and
// the idle sign-out on screens that show documents.
import { useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import { APP_ROLES, ROLE_LABELS, type AppRole } from '@shared/constants.ts';
import type { SecuritySettings } from '@shared/settings.ts';
import { Alert, Checkbox, Field, Input } from '@/components/ui/Field';
import { errorMessage } from '@/lib/errors';
import { useAuth } from '../../auth/AuthProvider';
import { useSaveSetting, useSetting } from '../../hooks/queries';
import { FormCard, Loader, SaveBar } from './FormParts';
import { Errors, parseWhole, sameJson } from './formUtils';

const RECOMMENDED: AppRole[] = ['owner', 'manager'];

export function SecurityTab() {
  const query = useSetting('security');
  return <Loader query={query}>{(data) => <SecurityForm key={query.dataUpdatedAt} initial={data} />}</Loader>;
}

function SecurityForm({ initial }: { initial: SecuritySettings }) {
  const save = useSaveSetting('security');
  const { refreshAccess } = useAuth();
  const toForm = (s: SecuritySettings) => ({
    mfa_required_roles: APP_ROLES.filter((r) => s.mfa_required_roles.includes(r)),
    session_hours: String(s.session_hours),
    document_idle_minutes: String(s.document_idle_minutes),
  });
  const [form, setForm] = useState(() => toForm(initial));
  const [errors, setErrors] = useState<Partial<Record<keyof SecuritySettings, string>>>({});
  const dirty = !sameJson(form, toForm(initial));
  const missingRecommended = RECOMMENDED.filter((r) => !form.mfa_required_roles.includes(r));

  function toggle(role: AppRole, on: boolean) {
    setForm((f) => ({
      ...f,
      mfa_required_roles: APP_ROLES.filter((r) => (r === role ? on : f.mfa_required_roles.includes(r))),
    }));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs = new Errors<keyof SecuritySettings>();
    const value: SecuritySettings = {
      mfa_required_roles: form.mfa_required_roles,
      session_hours: errs.take('session_hours', parseWhole(form.session_hours, 1, 12)),
      document_idle_minutes: errs.take('document_idle_minutes', parseWhole(form.document_idle_minutes, 1, 30)),
    };
    setErrors(errs.map);
    if (!errs.ok) {
      toast.error('Some settings need fixing. Check the highlighted fields.');
      return;
    }
    try {
      await save.mutateAsync(value);
      await refreshAccess();
      toast.success('Security settings saved.');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      <FormCard
        title="Two-step verification"
        description="People in these roles must enter a code from an authenticator app before they can see any data."
      >
        <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
          <legend className="sr-only">Roles that must use two-step verification</legend>
          {APP_ROLES.map((r) => (
            <Checkbox
              key={r}
              label={ROLE_LABELS[r]}
              description={RECOMMENDED.includes(r) ? 'Recommended: this role can see and download customer documents.' : 'Optional for counter staff.'}
              checked={form.mfa_required_roles.includes(r)}
              onChange={(e) => toggle(r, e.target.checked)}
            />
          ))}
        </fieldset>
        {missingRecommended.length > 0 && (
          <Alert tone="warning" title="Not recommended">
            {missingRecommended.map((r) => ROLE_LABELS[r]).join(' and ')} accounts can open customer licences and ID. Without two-step verification, a
            stolen password is enough to see them.
          </Alert>
        )}
      </FormCard>

      <FormCard title="Sessions" description="Shorter limits are safer on shared or counter phones.">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Sign out after (hours)" error={errors.session_hours} hint="Everyone signs in again after this long. Up to 12 hours.">
            <Input
              inputMode="numeric"
              value={form.session_hours}
              onChange={(e) => setForm((f) => ({ ...f, session_hours: e.target.value }))}
            />
          </Field>
          <Field
            label="Idle time on document screens (minutes)"
            error={errors.document_idle_minutes}
            hint="Signs out after this long without activity on a screen showing documents. Up to 30 minutes."
          >
            <Input
              inputMode="numeric"
              value={form.document_idle_minutes}
              onChange={(e) => setForm((f) => ({ ...f, document_idle_minutes: e.target.value }))}
            />
          </Field>
        </div>
      </FormCard>

      <SaveBar dirty={dirty} saving={save.isPending} hasErrors={Object.keys(errors).length > 0 && dirty} />
    </form>
  );
}
