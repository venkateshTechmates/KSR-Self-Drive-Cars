// Staff sign-in state. Same rules as the website: Owners and Managers need two-step
// verification before their role works (the server enforces it; this only routes the screens).
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AppRole } from '@shared/constants.ts';
import { auth } from './api';
import type { Session } from './types';

interface AuthState {
  loading: boolean;
  session: Session | null;
  /** Usable role (null until two-step is done where it is required). */
  role: AppRole | null;
  needsMfa: boolean;
  refresh: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<Session>;
  verifyCode: (code: string) => Promise<Session>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

const isSession = (s: Session | { user: null }): s is Session => s.user !== null;

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await auth.session();
      setSession(isSession(s) ? s : null);
    } catch {
      setSession(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<AuthState>(() => {
    const access = session?.access;
    return {
      loading,
      session,
      role: access?.effective_role ?? null,
      needsMfa: Boolean(access?.role && access.mfa_required && session?.aal !== 'aal2'),
      refresh,
      signIn: async (email, password) => {
        const s = await auth.login(email.trim(), password);
        setSession(s);
        return s;
      },
      verifyCode: async (code) => {
        const s = await auth.mfaVerify(code);
        setSession(s);
        return s;
      },
      signOut: async () => {
        try {
          await auth.logout();
        } finally {
          setSession(null);
          queryClient.removeQueries({ queryKey: ['staff'] });
        }
      },
    };
  }, [loading, session, refresh, queryClient]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}

export const isOwnerOrManager = (role: AppRole | null) => role === 'owner' || role === 'manager';
