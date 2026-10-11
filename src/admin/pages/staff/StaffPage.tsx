// /admin/staff (SET-05, ADM-02, ADM-07; Owner only). Invite, edit, change role, deactivate and
// reactivate staff accounts through the admin-staff edge function, which also writes the audit log.
import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Mail, Pencil, Power, UserPlus } from 'lucide-react';
import { APP_ROLES, ROLE_LABELS, type AppRole } from '@shared/constants.ts';
import { MESSAGES, normalizePhone, validateEmail } from '@shared/validation.ts';
import { Badge } from '@/components/ui/Badges';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog, Dialog, DialogFooter } from '@/components/ui/Dialog';
import { Alert, Field, Input, Select } from '@/components/ui/Field';
import { DataTable, EmptyState, PageHeader, type Column } from '@/components/ui/Layout';
import { PageSpinner } from '@/components/ui/Spinner';
import { errorMessage, toAppError } from '@/lib/errors';
import { formatPhone, formatRelativeDay } from '@/lib/format';
import { callFunction } from '@/lib/functions';
import { useNow } from '@/lib/useNow';
import { useAuth } from '../../auth/AuthProvider';
import { qk, useStaffDirectory, type StaffMember } from '../../hooks/queries';

type StaffAction =
  | { action: 'invite'; email: string; full_name: string; role: AppRole; phone?: string }
  | { action: 'set_role'; user_id: string; role: AppRole }
  | { action: 'deactivate' | 'reactivate' | 'resend_invite'; user_id: string }
  | { action: 'update_profile'; user_id: string; full_name?: string; phone?: string };

/** `link` is returned only when email (SMTP) isn't set up, so the Owner can share it themselves. */
const callStaff = (body: StaffAction) => callFunction<{ ok: true; user_id: string; link?: string }>('admin-staff', { body });

const ROLE_HELP: Record<AppRole, string> = {
  owner: 'Everything, including settings, staff accounts and the audit log.',
  manager: 'Daily operations: bookings, fleet, customers, documents, payments and reports. No settings or staff.',
  staff: "Handover and return: today's bookings only. Can view, but never download, customer documents.",
};

const SELF_NOTE = "You can't change your own role or deactivate your own account. Another Owner has to do it.";

/** Field errors the edge function returns in `hint`, e.g. { email: "Enter a valid email address." }. */
function fieldErrors(err: unknown): Record<string, string> {
  const hint = toAppError(err).hint;
  return hint && typeof hint === 'object' ? (hint as Record<string, string>) : {};
}

function validateName(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Enter their name.';
  if ([...n].length > 80) return 'Use 80 characters or fewer.';
  return null;
}

function validatePhoneOptional(phone: string): string | null {
  if (!phone.trim()) return null;
  return normalizePhone(phone) ? null : MESSAGES.phoneInvalid;
}

export default function StaffPage() {
  const { session } = useAuth();
  const me = session?.user.id ?? null;
  const now = useNow();
  const queryClient = useQueryClient();
  const directory = useStaffDirectory();

  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<StaffMember | null>(null);
  const [deactivating, setDeactivating] = useState<StaffMember | null>(null);
  const [reactivating, setReactivating] = useState<StaffMember | null>(null);
  const [resending, setResending] = useState<string | null>(null);
  const [shownLink, setShownLink] = useState<{ email: string; link: string } | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: qk.staff });

  async function resend(s: StaffMember) {
    setResending(s.user_id);
    try {
      const res = await callStaff({ action: 'resend_invite', user_id: s.user_id });
      if (res.link) setShownLink({ email: s.email, link: res.link });
      else toast.success(
        s.last_seen_at ? `Password reset email sent to ${s.email}.` : `Invite sent again to ${s.email}. If they've already joined, it's a password reset link.`,
      );
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setResending(null);
    }
  }

  const staff = directory.data ?? [];
  const activeCount = staff.filter((s) => s.active).length;

  const columns: Column<StaffMember>[] = [
    {
      key: 'name',
      header: 'Name',
      hideOnMobile: true,
      cell: (s) => (
        <span className="font-semibold">
          {s.full_name}
          {s.user_id === me && (
            <Badge tone="outline" className="ml-2">
              You
            </Badge>
          )}
        </span>
      ),
    },
    {
      key: 'contact',
      header: 'Contact',
      cell: (s) => (
        <span className="break-all">
          {s.email}
          {s.phone && <span className="block text-sm text-muted">{formatPhone(s.phone)}</span>}
        </span>
      ),
    },
    { key: 'role', header: 'Role', cell: (s) => (s.role ? ROLE_LABELS[s.role] : <span className="text-danger">No role</span>) },
    {
      key: 'status',
      header: 'Status',
      cell: (s) => (s.active ? <Badge tone="green">Active</Badge> : <Badge tone="grey">Inactive</Badge>),
    },
    {
      key: 'seen',
      header: 'Last seen',
      cell: (s) => (s.last_seen_at ? formatRelativeDay(s.last_seen_at, now) : <span className="text-muted">Not signed in yet</span>),
    },
    {
      key: 'actions',
      header: 'Actions',
      cell: (s) => {
        const self = s.user_id === me;
        return (
          <div className="flex flex-wrap justify-end gap-1 md:justify-start">
            <Button variant="ghost" size="sm" icon={<Pencil size={16} aria-hidden="true" />} onClick={() => setEditing(s)} aria-label={`Edit ${s.full_name}`}>
              Edit
            </Button>
            {s.active && (
              <Button
                variant="ghost"
                size="sm"
                icon={<Mail size={16} aria-hidden="true" />}
                onClick={() => void resend(s)}
                loading={resending === s.user_id}
                disabled={resending !== null}
                aria-label={`${s.last_seen_at ? 'Send a password reset to' : 'Resend invite to'} ${s.full_name}`}
              >
                {s.last_seen_at ? 'Reset password' : 'Resend invite'}
              </Button>
            )}
            {s.active ? (
              <Button
                variant="ghost"
                size="sm"
                icon={<Power size={16} aria-hidden="true" />}
                onClick={() => setDeactivating(s)}
                disabled={self}
                title={self ? SELF_NOTE : undefined}
                aria-label={`Deactivate ${s.full_name}`}
                className="text-danger hover:text-danger"
              >
                Deactivate
              </Button>
            ) : (
              <Button variant="ghost" size="sm" icon={<Power size={16} aria-hidden="true" />} onClick={() => setReactivating(s)} aria-label={`Reactivate ${s.full_name}`}>
                Reactivate
              </Button>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="Staff"
        description="Accounts that can sign in to the admin. Only the Owner can invite people or change roles."
        actions={
          <Button icon={<UserPlus size={18} aria-hidden="true" />} onClick={() => setInviting(true)}>
            Invite someone
          </Button>
        }
      />

      {directory.error ? (
        <Alert tone="error" title="Couldn't load staff">
          {errorMessage(directory.error)} Reload the page to try again.
        </Alert>
      ) : !directory.data ? (
        <PageSpinner label="Loading staff" />
      ) : (
        <div className="flex flex-col gap-4">
          <p className="m-0 text-[15px] text-muted">
            {activeCount} active of {staff.length}. {SELF_NOTE}
          </p>
          <DataTable
            rows={staff}
            columns={columns}
            rowKey={(s) => s.user_id}
            caption="Staff accounts"
            mobileTitle={(s) => (
              <p className="m-0 font-semibold">
                {s.full_name}
                {s.user_id === me && (
                  <Badge tone="outline" className="ml-2">
                    You
                  </Badge>
                )}
              </p>
            )}
            empty={<EmptyState title="No staff yet">Invite your managers and counter staff by email.</EmptyState>}
          />
        </div>
      )}

      <Dialog open={inviting} onClose={() => setInviting(false)} title="Invite someone" description="They get an email with a link to set their password.">
        <InviteForm
          onDone={async (invited) => {
            setInviting(false);
            if (invited) setShownLink(invited);
            await refresh();
          }}
          onCancel={() => setInviting(false)}
        />
      </Dialog>

      <Dialog
        open={shownLink !== null}
        onClose={() => setShownLink(null)}
        title="Share this link"
        description="Email isn't set up on the server, so no message was sent. Send this one-time link to them yourself (it works once)."
      >
        {shownLink && <LinkToShare email={shownLink.email} link={shownLink.link} onClose={() => setShownLink(null)} />}
      </Dialog>

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing ? `Edit ${editing.full_name}` : 'Edit'}>
        {editing && (
          <EditForm
            member={editing}
            isSelf={editing.user_id === me}
            onDone={async () => {
              setEditing(null);
              await refresh();
            }}
            onCancel={() => setEditing(null)}
          />
        )}
      </Dialog>

      <ConfirmDialog
        open={deactivating !== null}
        onClose={() => setDeactivating(null)}
        title={deactivating ? `Deactivate ${deactivating.full_name}?` : 'Deactivate'}
        description="This ends their sessions immediately and stops them signing in. Their name stays on past records. You can reactivate the account later."
        confirmLabel="Deactivate"
        tone="danger"
        onConfirm={async () => {
          if (!deactivating) return;
          await callStaff({ action: 'deactivate', user_id: deactivating.user_id });
          toast.success(`${deactivating.full_name} is deactivated and signed out.`);
          await refresh();
        }}
      />

      <ConfirmDialog
        open={reactivating !== null}
        onClose={() => setReactivating(null)}
        title={reactivating ? `Reactivate ${reactivating.full_name}?` : 'Reactivate'}
        description="They can sign in again with their existing password, with the same role as before."
        confirmLabel="Reactivate"
        onConfirm={async () => {
          if (!reactivating) return;
          await callStaff({ action: 'reactivate', user_id: reactivating.user_id });
          toast.success(`${reactivating.full_name} can sign in again.`);
          await refresh();
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------- dialogs

function RoleSelect({ value, onChange, disabled }: { value: AppRole; onChange: (r: AppRole) => void; disabled?: boolean }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value as AppRole)} disabled={disabled}>
      {APP_ROLES.map((r) => (
        <option key={r} value={r}>
          {ROLE_LABELS[r]}
        </option>
      ))}
    </Select>
  );
}

function LinkToShare({ email, link, onClose }: { email: string; link: string; onClose: () => void }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0">For {email}:</p>
      <code className="block rounded-lg border border-line bg-subtle p-3 text-sm break-all">{link}</code>
      <DialogFooter>
        <Button
          variant="secondary"
          onClick={() =>
            navigator.clipboard.writeText(link).then(
              () => toast.success('Link copied'),
              () => toast.error('Copy failed. Select the link and copy it.'),
            )
          }
        >
          Copy link
        </Button>
        <Button onClick={onClose}>Done</Button>
      </DialogFooter>
    </div>
  );
}

function InviteForm({ onDone, onCancel }: { onDone: (shareLink?: { email: string; link: string }) => Promise<void>; onCancel: () => void }) {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AppRole>('staff');
  const [phone, setPhone] = useState('');
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next = {
      full_name: validateName(fullName),
      email: email.trim() ? validateEmail(email.trim()) : 'Enter their email address.',
      phone: validatePhoneOptional(phone),
    };
    setErrors(next);
    setFormError(null);
    if (Object.values(next).some(Boolean)) return;
    setBusy(true);
    try {
      const res = await callStaff({
        action: 'invite',
        email: email.trim().toLowerCase(),
        full_name: fullName.trim(),
        role,
        phone: phone.trim() ? normalizePhone(phone) ?? undefined : undefined,
      });
      if (res.link) await onDone({ email: email.trim(), link: res.link });
      else {
        toast.success(`Invite sent to ${email.trim()}.`);
        await onDone();
      }
    } catch (err) {
      const fields = fieldErrors(err);
      if (Object.keys(fields).length) setErrors((prev) => ({ ...prev, ...fields }));
      else setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <Field label="Full name" required error={errors.full_name}>
        <Input value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="off" maxLength={80} autoFocus />
      </Field>
      <Field label="Email" required error={errors.email} hint="The invite goes here, and they sign in with it.">
        <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
      </Field>
      <Field label="Role" required error={errors.role} hint={ROLE_HELP[role]}>
        <RoleSelect value={role} onChange={setRole} />
      </Field>
      <Field label="Mobile number" optional error={errors.phone}>
        <Input type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="off" />
      </Field>
      {role !== 'staff' && <Alert tone="info">Owners and Managers set up two-step verification (an authenticator app) the first time they sign in.</Alert>}
      {formError && <Alert tone="error">{formError}</Alert>}
      <DialogFooter>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" loading={busy} loadingText="Sending…">
          Send invite
        </Button>
      </DialogFooter>
    </form>
  );
}

function EditForm({
  member,
  isSelf,
  onDone,
  onCancel,
}: {
  member: StaffMember;
  isSelf: boolean;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const [fullName, setFullName] = useState(member.full_name);
  const [phone, setPhone] = useState(member.phone ? formatPhone(member.phone) : '');
  const [role, setRole] = useState<AppRole>(member.role ?? 'staff');
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next = { full_name: validateName(fullName), phone: validatePhoneOptional(phone) };
    setErrors(next);
    setFormError(null);
    if (Object.values(next).some(Boolean)) return;

    const newPhone = phone.trim() ? normalizePhone(phone) : null;
    const profileChanged = fullName.trim() !== member.full_name || newPhone !== (member.phone ?? null);
    const roleChanged = !isSelf && role !== member.role;
    if (!profileChanged && !roleChanged) {
      onCancel();
      return;
    }
    setBusy(true);
    try {
      if (profileChanged) {
        await callStaff({ action: 'update_profile', user_id: member.user_id, full_name: fullName.trim(), phone: newPhone ?? '' });
      }
      if (roleChanged) await callStaff({ action: 'set_role', user_id: member.user_id, role });
      toast.success(`Saved changes for ${fullName.trim()}.`);
      await onDone();
    } catch (err) {
      const fields = fieldErrors(err);
      if (Object.keys(fields).length) setErrors((prev) => ({ ...prev, ...fields }));
      else setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <p className="m-0 break-all text-[15px] text-muted">Signs in as {member.email}</p>
      <Field label="Full name" required error={errors.full_name}>
        <Input value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={80} autoFocus />
      </Field>
      <Field label="Mobile number" optional error={errors.phone} hint="Leave blank to remove it.">
        <Input type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </Field>
      <Field label="Role" error={errors.role} hint={isSelf ? SELF_NOTE : ROLE_HELP[role]}>
        <RoleSelect value={role} onChange={setRole} disabled={isSelf} />
      </Field>
      {!isSelf && member.role && role !== member.role && (
        <Alert tone="warning">
          Changing from {ROLE_LABELS[member.role]} to {ROLE_LABELS[role]} changes what they can see straight away.
          {role !== 'staff' && member.role === 'staff' && ' They will be asked to set up two-step verification.'}
        </Alert>
      )}
      {formError && <Alert tone="error">{formError}</Alert>}
      <DialogFooter>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" loading={busy} loadingText="Saving…">
          Save changes
        </Button>
      </DialogFooter>
    </form>
  );
}
