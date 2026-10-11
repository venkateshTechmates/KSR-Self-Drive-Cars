// Admin sign-in against /api/auth (session cookie, two-step verification, password links).
import type { MyAccess } from '@/types/db';
import { API_HEADERS, apiPost } from './client';
import { AppError } from '@/lib/errors';

export interface AuthSession {
  user: { id: string; email: string };
  aal: 'aal1' | 'aal2';
  mfa_enrolled: boolean;
  access: MyAccess;
}

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const r = await apiPost<T>(`/api/auth/${path}`, body);
  if (r.error) throw new AppError(r.error.message, r.error.details, r.error.hint, r.status);
  return r.data as T;
}

export async function getSession(): Promise<AuthSession | null> {
  const res = await fetch('/api/auth/session', { credentials: 'same-origin', headers: API_HEADERS });
  if (!res.ok) throw new AppError("Couldn't check your sign-in. Try again.", 'network', null, res.status);
  const json = (await res.json()) as AuthSession | { user: null };
  return json.user ? (json as AuthSession) : null;
}

export const login = (email: string, password: string) => post<AuthSession>('login', { email, password });

export const logout = (reason: 'manual' | 'timeout' | 'session_limit' = 'manual') => post<{ ok: true }>('logout', { reason });

export const mfaEnroll = () => post<{ secret: string; uri: string; qr: string }>('mfa/enroll');

export const mfaVerify = (code: string) => post<AuthSession>('mfa/verify', { code });

export const forgotPassword = (email: string) => post<{ ok: true }>('password/forgot', { email });

export async function passwordTokenInfo(token: string): Promise<{ valid: boolean; kind?: 'invite' | 'reset'; email?: string }> {
  const res = await fetch(`/api/auth/password/token?token=${encodeURIComponent(token)}`, { credentials: 'same-origin' });
  return res.ok ? res.json() : { valid: false };
}

export const resetPassword = (token: string, password: string) => post<AuthSession>('password/reset', { token, password });
