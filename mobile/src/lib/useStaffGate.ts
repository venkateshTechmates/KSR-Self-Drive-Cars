// Staff screens: send people to sign-in, or to two-step verification, before showing data.
import { router } from 'expo-router';
import { useEffect } from 'react';
import { useAuth } from './auth';

export function useStaffGate() {
  const { loading, session, needsMfa, role } = useAuth();
  useEffect(() => {
    if (loading) return;
    if (!session) router.replace('/staff/login');
    else if (needsMfa) router.replace('/staff/mfa');
  }, [loading, session, needsMfa]);
  return { ready: !loading && Boolean(session) && !needsMfa, role, loading };
}
