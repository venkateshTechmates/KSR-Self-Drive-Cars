import { useEffect, useRef, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import type { AppRole } from '@shared/constants.ts';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/Layout';
import { PageSpinner } from '@/components/ui/Spinner';
import { isSupabaseConfigured } from '@/integrations/supabase/client';
import { useAuth } from './AuthProvider';

/** Signed in, active, with a role and (where required) two-step verification done. */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { loading, session, access, role, needsMfa, accessError, refreshAccess, signOut } = useAuth();
  const location = useLocation();
  if (!isSupabaseConfigured) {
    return (
      <div className="mx-auto max-w-lg p-6">
        <EmptyState title="The admin needs a Supabase project">
          Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY (see README), then reload.
        </EmptyState>
      </div>
    );
  }
  if (session && !access && accessError && !loading) {
    return (
      <div className="mx-auto max-w-lg p-6">
        <EmptyState
          title="Couldn't check your access"
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => void refreshAccess()}>Try again</Button>
              <Button variant="secondary" onClick={() => void signOut()}>
                Sign out
              </Button>
            </div>
          }
        >
          Check your connection, then try again.
        </EmptyState>
      </div>
    );
  }
  if (loading || (session && !access)) return <PageSpinner />;
  if (!session) return <Navigate to="/admin/login" replace state={{ from: location.pathname + location.search }} />;
  if (needsMfa) return <Navigate to="/admin/mfa" replace state={{ from: location.pathname + location.search }} />;
  if (!role) {
    return (
      <div className="mx-auto max-w-lg p-6">
        <EmptyState title="No admin access">
          This account is not active or has no role. Ask the Owner to check your account in Staff.
        </EmptyState>
      </div>
    );
  }
  return <>{children}</>;
}

/** Hide a whole screen from roles that may not use it (the database refuses the data anyway). */
export function RequireRole({ roles, children }: { roles: readonly AppRole[]; children: ReactNode }) {
  const { role } = useAuth();
  if (!role || !roles.includes(role)) {
    return (
      <EmptyState title="Not available for your role">
        Ask the Owner if you need access to this screen.
      </EmptyState>
    );
  }
  return <>{children}</>;
}

/**
 * ADM-05: sign out after N minutes without activity on screens showing documents.
 * Call at the top of any page that shows customer documents.
 */
export function useDocumentIdleTimeout() {
  const { access, signOut } = useAuth();
  const minutes = Number((access?.security as { document_idle_minutes?: number } | undefined)?.document_idle_minutes ?? 30);
  const last = useRef(0);
  useEffect(() => {
    last.current = Date.now();
    const bump = () => {
      last.current = Date.now();
    };
    const events = ['pointerdown', 'keydown', 'scroll', 'touchstart'] as const;
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const t = window.setInterval(() => {
      if (Date.now() - last.current > minutes * 60_000) void signOut('timeout');
    }, 30_000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, bump));
      window.clearInterval(t);
    };
  }, [minutes, signOut]);
}
