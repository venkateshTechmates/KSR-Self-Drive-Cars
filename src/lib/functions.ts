// Call the server's function endpoints (/api/fn/<name>), e.g. submit-booking, document-upload.
// The session cookie identifies the user; every call carries the CSRF header.
import { API_HEADERS, onSessionExpiredNotify } from '@/integrations/api/client';
import { AppError } from './errors';

interface CallOptions {
  method?: 'GET' | 'POST';
  query?: Record<string, string | undefined>;
  /** JSON body (ignored when formData is given). */
  body?: unknown;
  formData?: FormData;
  /** Kept for compatibility; the cookie decides who is calling. */
  anonymous?: boolean;
  signal?: AbortSignal;
}

export async function callFunction<T>(name: string, opts: CallOptions = {}): Promise<T> {
  const url = new URL(`/api/fn/${name}`, window.location.origin);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);

  const headers: Record<string, string> = { ...API_HEADERS };
  let body: BodyInit | undefined;
  if (opts.formData) body = opts.formData;
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(url, { method: opts.method ?? 'POST', headers, body, credentials: 'same-origin', signal: opts.signal });
  } catch {
    throw new AppError("Couldn't reach the server. Check your connection and try again.", 'network');
  }

  const text = await res.text();
  const json = parseJson(text);
  if (!res.ok) {
    if (res.status === 401) onSessionExpiredNotify();
    const j = (json ?? {}) as { error?: string; message?: string; code?: string; hint?: unknown };
    throw new AppError(j.error ?? j.message ?? `Request failed (${res.status}).`, j.code ?? null, j.hint ?? null, res.status);
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
