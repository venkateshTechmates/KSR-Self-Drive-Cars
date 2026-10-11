import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY) as string | undefined;

/** False when the app runs without a backend (the public site then shows the bundled demo fleet). */
export const isSupabaseConfigured = Boolean(url && key);

export const SUPABASE_URL = (url ?? 'http://localhost:54321').replace(/\/$/, '');
export const SUPABASE_KEY = key ?? 'not-configured';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: 'ksr-admin-auth',
  },
});
