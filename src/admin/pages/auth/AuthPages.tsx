// /admin/login, /admin/mfa and /admin/reset-password (ADM-02, ADM-03, ADM-07).
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { KsrLogo } from '@/components/brand/Brand';
import { Button } from '@/components/ui/Button';
import { Alert, Field, Input } from '@/components/ui/Field';
import { PageSpinner } from '@/components/ui/Spinner';
import { supabase } from '@/integrations/supabase/client';
import { errorMessage } from '@/lib/errors';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { useAuth } from '../../auth/AuthProvider';

function AuthCard({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  useDocumentMeta({ title: `${title} · KSR admin`, noindex: true });
  return (
    <main className="flex min-h-dvh items-start justify-center bg-page px-4 py-10 sm:items-center">
      <div className="w-full max-w-md">
        <div className="mb-6 flex justify-center">
          <KsrLogo />
        </div>
        <div className="rounded-2xl border border-line-card bg-surface p-6 sm:p-8">
          <h1 className="m-0 mb-5 text-2xl font-extrabold">{title}</h1>
          {children}
        </div>
        {footer && <div className="mt-4 text-center text-[15px]">{footer}</div>}
      </div>
    </main>
  );
}

const fromState = (state: unknown) => ((state as { from?: string } | null)?.from ?? '/admin') as string;

export function LoginPage() {
  const { session, access, role, needsMfa, signIn, signOutReason, loading } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (loading) return <PageSpinner />;
  if (session && access) {
    if (needsMfa) return <Navigate to="/admin/mfa" replace state={location.state} />;
    if (role) return <Navigate to={fromState(location.state)} replace />;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setBusy(true);
    try {
      await signIn(email, password);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Sign in" footer={<Link to="/admin/reset-password">Forgot your password?</Link>}>
      {signOutReason && (
        <Alert tone="info" className="mb-4">
          {signOutReason}
        </Alert>
      )}
      {session && access && !access.role && (
        <Alert tone="warning" className="mb-4">
          This account has no admin access. Ask the Owner to check it in Staff.
        </Alert>
      )}
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="Email">
          <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label="Password">
          <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        {error && <Alert>{error}</Alert>}
        <Button type="submit" size="lg" loading={busy} loadingText="Signing in…">
          Sign in
        </Button>
      </form>
    </AuthCard>
  );
}

type MfaStep = { kind: 'loading' } | { kind: 'enroll'; factorId: string; qr: string; secret: string } | { kind: 'challenge'; factorId: string };

export function MfaPage() {
  const { session, access, role, needsMfa, refreshAccess, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [step, setStep] = useState<MfaStep>({ kind: 'loading' });
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Keyed on the user, not the session object: Supabase emits a new session object on every
  // tab refocus and token refresh, and re-running would replace the factor being set up.
  const userId = session?.user.id;

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      try {
        const { data, error: e } = await supabase.auth.mfa.listFactors();
        if (e) throw e;
        const verified = data.totp.find((f) => f.status === 'verified');
        if (verified) {
          if (!cancelled) setStep({ kind: 'challenge', factorId: verified.id });
          return;
        }
        // Clean up half-finished enrolments, then start a new one.
        for (const f of data.all.filter((x) => x.status === 'unverified')) await supabase.auth.mfa.unenroll({ factorId: f.id });
        const { data: en, error: e2 } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: `KSR ${new Date().toISOString().slice(0, 10)}` });
        if (e2) throw e2;
        if (!cancelled) setStep({ kind: 'enroll', factorId: en.id, qr: en.totp.qr_code, secret: en.totp.secret });
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (!session) return <Navigate to="/admin/login" replace />;
  if (access && role && !needsMfa) return <Navigate to={fromState(location.state)} replace />;

  async function verify(e: FormEvent) {
    e.preventDefault();
    if (step.kind === 'loading') return;
    if (!/^\d{6}$/.test(code.trim())) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { data: ch, error: e1 } = await supabase.auth.mfa.challenge({ factorId: step.factorId });
      if (e1) throw e1;
      const { error: e2 } = await supabase.auth.mfa.verify({ factorId: step.factorId, challengeId: ch.id, code: code.trim() });
      if (e2) throw new Error('That code is not right, or it expired. Try the current code.');
      await supabase.rpc('log_client_event', {
        p_action: step.kind === 'enroll' ? 'auth.mfa_enrolled' : 'auth.mfa_verified',
        p_entity_type: 'auth',
        p_entity_id: null,
        p_meta: null,
      });
      await refreshAccess();
      navigate(fromState(location.state), { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title={step.kind === 'enroll' ? 'Set up two-step verification' : 'Two-step verification'}
      footer={
        <button type="button" className="min-h-11 bg-transparent font-semibold text-action underline" onClick={() => void signOut()}>
          Sign out
        </button>
      }
    >
      {step.kind === 'loading' && !error && <PageSpinner />}
      {step.kind === 'enroll' && (
        <div className="mb-5 flex flex-col gap-3 text-[15px]">
          <p className="m-0">
            Owner and Manager accounts need an authenticator app (Google Authenticator, Microsoft Authenticator or similar). Scan this code
            with the app, then enter the 6-digit code it shows.
          </p>
          <img src={step.qr} alt="QR code for your authenticator app" width={180} height={180} className="self-center rounded-lg border border-line bg-white p-2" />
          <p className="m-0 text-sm text-muted">
            Can&apos;t scan? Enter this key in the app: <code className="break-all font-mono text-ink">{step.secret}</code>
          </p>
        </div>
      )}
      {step.kind === 'challenge' && <p className="m-0 mb-5 text-[15px]">Enter the 6-digit code from your authenticator app.</p>}
      {step.kind !== 'loading' && (
        <form onSubmit={verify} className="flex flex-col gap-4" noValidate>
          <Field label="6-digit code">
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              autoFocus
            />
          </Field>
          {error && <Alert>{error}</Alert>}
          <Button type="submit" size="lg" loading={busy} loadingText="Checking…">
            Verify
          </Button>
        </form>
      )}
      {step.kind === 'loading' && error && <Alert>{error}</Alert>}
    </AuthCard>
  );
}

/** Request a reset email, or (arriving from the email/invite link) set a new password. */
export function ResetPasswordPage() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const arrivedFromLink = typeof window !== 'undefined' && /type=(recovery|invite)|access_token|code=/.test(window.location.hash + window.location.search);

  async function requestReset(e: FormEvent) {
    e.preventDefault();
    if (!email.trim()) {
      setError('Enter your email.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { error: err } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/admin/reset-password`,
      });
      if (err) throw err;
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function setNewPassword(e: FormEvent) {
    e.preventDefault();
    if (password.length < 10) {
      setError('Use at least 10 characters.');
      return;
    }
    if (password !== confirm) {
      setError('The two passwords are different.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { error: err } = await supabase.auth.updateUser({ password });
      if (err) throw err;
      navigate('/admin', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (session || arrivedFromLink) {
    return (
      <AuthCard title="Choose a new password">
        {!session && <PageSpinner label="Checking your link" />}
        {session && (
          <form onSubmit={setNewPassword} className="flex flex-col gap-4" noValidate>
            <Field label="New password" hint="At least 10 characters.">
              <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Field label="Type it again">
              <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </Field>
            {error && <Alert>{error}</Alert>}
            <Button type="submit" size="lg" loading={busy}>
              Save password
            </Button>
          </form>
        )}
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Reset your password" footer={<Link to="/admin/login">Back to sign in</Link>}>
      {sent ? (
        <Alert tone="success">If that email has an admin account, we sent a link to reset the password. Check your inbox.</Alert>
      ) : (
        <form onSubmit={requestReset} className="flex flex-col gap-4" noValidate>
          <Field label="Email">
            <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          {error && <Alert>{error}</Alert>}
          <Button type="submit" size="lg" loading={busy}>
            Send reset link
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
