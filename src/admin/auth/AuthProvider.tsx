// Admin authentication state: Supabase session + the user's role from `my_access()`.
// Owner and Manager must complete two-step verification (aal2) before the database
// returns any data (ADM-03); the UI routes them to /admin/mfa until they do.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { useQueryClient } from '@tanstack/react-query';
import type { AppRole } from '@shared/constants.ts';
import { isSupabaseConfigured, supabase } from '@/integrations/supabase/client';
import { toAppError } from '@/lib/errors';
import type { MyAccess } from '@/types/db';

const SESSION_START_KEY = 'ksr.sessionStartedAt';

export interface AuthState {
  loading: boolean;
  session: Session | null;
  access: MyAccess | null;
  /** Role usable for data access right now (null until two-step is done where required). */
  role: AppRole | null;
  /** True when the user has a role but still needs to complete or set up two-step verification. */
  needsMfa: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: (reason?: 'manual' | 'timeout' | 'session_limit') => Promise<void>;
  refreshAccess: () => Promise<MyAccess | null>;
  signOutReason: string | null;
  /** The first access check failed (network/server); RequireAdmin offers a retry. */
  accessError: boolean;
}

const AuthContext = createContext<AuthState | null>(null);

async function fetchAccess(): Promise<MyAccess | null> {
  const { data, error } = await supabase.rpc('my_access');
  if (error) throw toAppError(error);
  return data as MyAccess;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [session, setSession] = useState<Session | null>(null);
  const [access, setAccess] = useState<MyAccess | null>(null);
  const [signOutReason, setSignOutReason] = useState<string | null>(null);
  const [accessError, setAccessError] = useState(false);

  const refreshAccess = useCallback(async () => {
    try {
      const a = await fetchAccess();
      setAccess(a);
      setAccessError(false);
      return a;
    } catch {
      setAccessError(true);
      // Keep the last known access on a network or server error (e.g. the refresh that runs when
      // the tab regains focus, while offline). Clearing it would swap every screen, and any
      // half-filled form, for an endless spinner. Signing out clears it (SIGNED_OUT below).
      return null;
    }
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    let mounted = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      if (data.session) await refreshAccess();
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      setSession(next);
      if (event === 'SIGNED_OUT') {
        setAccess(null);
        queryClient.clear();
        localStorage.removeItem(SESSION_START_KEY);
      } else if (next) {
        if (event === 'SIGNED_IN' && !localStorage.getItem(SESSION_START_KEY)) {
          localStorage.setItem(SESSION_START_KEY, String(Date.now()));
        }
        // Defer: calling Supabase inside the callback can deadlock the auth lock.
        setTimeout(() => {
          void refreshAccess();
          if (event === 'MFA_CHALLENGE_VERIFIED') void queryClient.invalidateQueries();
        }, 0);
      }
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, [queryClient, refreshAccess]);

  const signIn = useCallback(async (email: string, password: string) => {
    setSignOutReason(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) {
      const msg = /too many failed attempts/i.test(error.message)
        ? 'Too many failed attempts. Try again in 15 minutes.'
        : /invalid login credentials/i.test(error.message)
          ? 'Email or password is not right.'
          : error.message;
      throw toAppError({ message: msg });
    }
    localStorage.setItem(SESSION_START_KEY, String(Date.now()));
  }, []);

  const signOut = useCallback(async (reason: 'manual' | 'timeout' | 'session_limit' = 'manual') => {
    try {
      await supabase.rpc('log_client_event', {
        p_action: reason === 'manual' ? 'auth.logout' : 'auth.session_timeout',
        p_entity_type: 'auth',
        p_entity_id: null,
        p_meta: { reason },
      });
    } catch {
      // Logging must not block signing out.
    }
    await supabase.auth.signOut();
    setSignOutReason(
      reason === 'timeout'
        ? 'You were signed out after 30 minutes without activity on a screen showing documents.'
        : reason === 'session_limit'
          ? 'Your session reached its 12-hour limit. Sign in again.'
          : null,
    );
  }, []);

  // ADM-05: hard session limit (12 hours by default, from Settings > security).
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
    return { loading, session, access, role, needsMfa, signIn, signOut, refreshAccess, signOutReason, accessError };
  }, [loading, session, access, signIn, signOut, refreshAccess, signOutReason, accessError]);

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
