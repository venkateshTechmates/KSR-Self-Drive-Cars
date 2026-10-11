// /admin/login, /admin/mfa and /admin/reset-password (ADM-02, ADM-03, ADM-07).
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { KsrLogo } from '@/components/brand/Brand';
import { Button } from '@/components/ui/Button';
import { Alert, Field, Input } from '@/components/ui/Field';
import { PageSpinner } from '@/components/ui/Spinner';
import { forgotPassword, mfaEnroll, mfaVerify, passwordTokenInfo, resetPassword } from '@/integrations/api/auth';
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

export function MfaPage() {
  const { session, access, role, needsMfa, applySession, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const enrolled = session?.mfa_enrolled ?? false;

  // Not enrolled yet: fetch one secret + QR code per user and keep it while they scan
  // (switching to the authenticator app and back must not replace it).
  const enrolment = useQuery({
    queryKey: ['mfa-enrol', session?.user.id],
    enabled: Boolean(session && !enrolled),
    queryFn: mfaEnroll,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });

  if (!session) return <Navigate to="/admin/login" replace />;
  if (access && role && !needsMfa) return <Navigate to={fromState(location.state)} replace />;

  async function verify(e: FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(code.trim())) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const s = await mfaVerify(code.trim());
      applySession(s);
      navigate(fromState(location.state), { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title={enrolled ? 'Two-step verification' : 'Set up two-step verification'}
      footer={
        <button type="button" className="min-h-11 bg-transparent font-semibold text-action underline" onClick={() => void signOut()}>
          Sign out
        </button>
      }
    >
      {!enrolled && enrolment.isLoading && <PageSpinner />}
      {!enrolled && enrolment.error && <Alert>{errorMessage(enrolment.error)}</Alert>}
      {!enrolled && enrolment.data && (
        <div className="mb-5 flex flex-col gap-3 text-[15px]">
          <p className="m-0">
            Owner and Manager accounts need an authenticator app (Google Authenticator, Microsoft Authenticator or similar). Scan this code
            with the app, then enter the 6-digit code it shows.
          </p>
          <img
            src={enrolment.data.qr}
            alt="QR code for your authenticator app"
            width={200}
            height={200}
            className="self-center rounded-lg border border-line bg-white p-2"
          />
          <p className="m-0 text-sm text-muted">
            Can&apos;t scan? Enter this key in the app: <code className="break-all font-mono text-ink">{enrolment.data.secret}</code>
          </p>
        </div>
      )}
      {enrolled && <p className="m-0 mb-5 text-[15px]">Enter the 6-digit code from your authenticator app.</p>}
      {(enrolled || enrolment.data) && (
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
    </AuthCard>
  );
}

/** Request a reset email, or (arriving from an email or invite link) choose a password. */
export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token');
  return token ? <ChoosePassword token={token} /> : <RequestReset />;
}

function RequestReset() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim()) {
      setError('Enter your email.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await forgotPassword(email.trim());
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Reset your password" footer={<Link to="/admin/login">Back to sign in</Link>}>
      {sent ? (
        <Alert tone="success">If that email has an admin account, we sent a link to reset the password. Check your inbox.</Alert>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
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

function ChoosePassword({ token }: { token: string }) {
  const { applySession } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const info = useQuery({ queryKey: ['password-token', token], queryFn: () => passwordTokenInfo(token), retry: false, staleTime: Infinity });

  // Keep the token out of the address bar and history once it has been read.
  useEffect(() => {
    if (info.data) window.history.replaceState(window.history.state, '', window.location.pathname);
  }, [info.data]);

  async function submit(e: FormEvent) {
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
      applySession(await resetPassword(token, password));
      navigate('/admin', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const invite = info.data?.kind === 'invite';
  return (
    <AuthCard title={invite ? 'Welcome! Choose your password' : 'Choose a new password'} footer={<Link to="/admin/login">Back to sign in</Link>}>
      {info.isLoading && <PageSpinner label="Checking your link" />}
      {info.data && !info.data.valid && (
        <Alert title="This link can't be used">It has expired or was already used. Ask the Owner for a new invite, or request a new reset link.</Alert>
      )}
      {info.data?.valid && (
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <p className="m-0 text-[15px] text-muted">{info.data.email}</p>
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
