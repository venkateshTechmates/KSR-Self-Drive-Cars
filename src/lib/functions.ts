// Call Supabase edge functions with the signed-in user's token (or the publishable key).
import { SUPABASE_KEY, SUPABASE_URL, supabase } from '@/integrations/supabase/client';
import { AppError } from './errors';

interface CallOptions {
  method?: 'GET' | 'POST';
  query?: Record<string, string | undefined>;
  /** JSON body (ignored when formData is given). */
  body?: unknown;
  formData?: FormData;
  /** Use only the publishable key, even if someone is signed in (public endpoints). */
  anonymous?: boolean;
  signal?: AbortSignal;
}

export async function callFunction<T>(name: string, opts: CallOptions = {}): Promise<T> {
  const url = new URL(`${SUPABASE_URL}/functions/v1/${name}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);

  const headers: Record<string, string> = { apikey: SUPABASE_KEY };
  let token = SUPABASE_KEY;
  if (!opts.anonymous) {
    const { data } = await supabase.auth.getSession();
    if (data.session?.access_token) token = data.session.access_token;
  }
  headers.Authorization = `Bearer ${token}`;

  let body: BodyInit | undefined;
  if (opts.formData) body = opts.formData;
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(url, { method: opts.method ?? 'POST', headers, body, signal: opts.signal });
  } catch {
    throw new AppError("Couldn't reach the server. Check your connection and try again.", 'network');
  }

  const text = await res.text();
  const json = parseJson(text);
  if (!res.ok) {
    const j = (json ?? {}) as { error?: string; code?: string; hint?: unknown };
    throw new AppError(j.error ?? `Request failed (${res.status}).`, j.code ?? null, j.hint ?? null, res.status);
  }
  return json as T;
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
