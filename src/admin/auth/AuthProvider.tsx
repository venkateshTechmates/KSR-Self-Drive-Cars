// Admin authentication state: the server session (HttpOnly cookie) + the user's role from
// my_access. Owner and Manager must complete two-step verification (aal2) before the server
// returns any data (ADM-03); the UI routes them to /admin/mfa until they do.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AppRole } from '@shared/constants.ts';
import { getSession, login, logout, type AuthSession } from '@/integrations/api/auth';
import { onSessionExpired } from '@/integrations/api/client';
import type { MyAccess } from '@/types/db';

const SESSION_START_KEY = 'ksr.sessionStartedAt';

export interface AuthState {
  loading: boolean;
  session: AuthSession | null;
  access: MyAccess | null;
  /** Role usable for data access right now (null until two-step is done where required). */
  role: AppRole | null;
  /** True when the user has a role but still needs to complete or set up two-step verification. */
  needsMfa: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: (reason?: 'manual' | 'timeout' | 'session_limit') => Promise<void>;
  refreshAccess: () => Promise<MyAccess | null>;
  /** Use a session returned by the server (two-step verified, password set). */
  applySession: (session: AuthSession) => void;
  signOutReason: string | null;
  /** The first access check failed (network/server); RequireAdmin offers a retry. */
  accessError: boolean;
}

const AuthContext = createContext<AuthState | null>(null);

const REASONS = {
  timeout: 'You were signed out after 30 minutes without activity on a screen showing documents.',
  session_limit: 'Your session reached its 12-hour limit. Sign in again.',
  expired: 'Your session ended. Sign in again.',
} as const;

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [signOutReason, setSignOutReason] = useState<string | null>(null);
  const [accessError, setAccessError] = useState(false);
  const access = session?.access ?? null;

  const clear = useCallback(
    (reason: string | null) => {
      setSession(null);
      queryClient.clear();
      localStorage.removeItem(SESSION_START_KEY);
      setSignOutReason(reason);
    },
    [queryClient],
  );

  const refreshAccess = useCallback(async () => {
    try {
      const s = await getSession();
      setSession(s);
      setAccessError(false);
      return s?.access ?? null;
    } catch {
      // Keep the last known session on a network error: clearing it would swap every screen,
      // and any half-filled form, for a spinner. The server still enforces access.
      setAccessError(true);
      return null;
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    getSession()
      .then((s) => mounted && setSession(s))
      .catch(() => mounted && setAccessError(true))
      .finally(() => mounted && setLoading(false));
    const off = onSessionExpired(() => clear(REASONS.expired));
    return () => {
      mounted = false;
      off();
    };
  }, [clear]);

  const applySession = useCallback(
    (s: AuthSession) => {
      setSession(s);
      setAccessError(false);
      setSignOutReason(null);
      if (!localStorage.getItem(SESSION_START_KEY)) localStorage.setItem(SESSION_START_KEY, String(Date.now()));
      // Two-step may have just unlocked data the cached queries didn't have.
      void queryClient.invalidateQueries();
    },
    [queryClient],
  );

  const signIn = useCallback(
    async (email: string, password: string) => {
      setSignOutReason(null);
      const s = await login(email.trim(), password);
      localStorage.setItem(SESSION_START_KEY, String(Date.now()));
      applySession(s);
    },
    [applySession],
  );

  const signOut = useCallback(
    async (reason: 'manual' | 'timeout' | 'session_limit' = 'manual') => {
      try {
        await logout(reason);
      } catch {
        // Signing out locally must not depend on the network.
      }
      clear(reason === 'manual' ? null : REASONS[reason]);
    },
    [clear],
  );

  // ADM-05: the server ends sessions after the limit; this shows a clear message when it does.
  useEffect(() => {
    if (!session) return;
    const hours = Number((access?.security as { session_hours?: number } | undefined)?.session_hours ?? 12);
    const check = () => {
      const started = Number(localStorage.getItem(SESSION_START_KEY) ?? Date.now());
      if (Date.now() - started > hours * 3_600_000) void signOut('session_limit');
    };
    check();
    const t = window.setInterval(check, 60_000);
    return () => window.clearInterval(t);
  }, [session, access, signOut]);

  const value = useMemo<AuthState>(() => {
    const role = access?.effective_role ?? null;
    const needsMfa = Boolean(access?.role && !access.effective_role && access.mfa_required && access.aal !== 'aal2');
    return { loading, session, access, role, needsMfa, signIn, signOut, refreshAccess, applySession, signOutReason, accessError };
  }, [loading, session, access, signIn, signOut, refreshAccess, applySession, signOutReason, accessError]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** The signed-in admin's role; components under <RequireAdmin> can rely on it being set. */
export function useRole(): AppRole {
  const { role } = useAuth();
  return role ?? 'staff';
}

export const isOwnerOrManager = (role: AppRole | null | undefined) => role === 'owner' || role === 'manager';
