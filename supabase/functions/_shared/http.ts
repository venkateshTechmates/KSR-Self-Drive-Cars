// HTTP plumbing shared by every edge function: JSON responses, OPTIONS handling, error mapping.
// Error bodies are always { error: <message for people>, code: <machine code>, hint?: <extra> }.
import { corsHeaders } from './cors.ts';

export { corsHeaders };

/** An error that should reach the caller as-is. Anything else becomes a generic 500. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string,
    public readonly hint?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

export function errorResponse(status: number, error: string, code: string, hint?: unknown): Response {
  const body: Record<string, unknown> = { error, code };
  if (hint !== undefined && hint !== null) body.hint = hint;
  return json(body, status);
}

export const GENERIC_ERROR = 'Something went wrong. Try again.';

/** Shape of errors returned by supabase-js for PostgREST / RPC calls. */
export interface PgErrorLike {
  message?: string;
  details?: string | null;
  hint?: string | null;
  code?: string;
}

function parseHint(hint: string | null | undefined): unknown {
  if (!hint) return undefined;
  try {
    return JSON.parse(hint);
  } catch {
    return hint;
  }
}

/**
 * Map a database error to an HttpError. SQL functions raise errors whose message is written
 * for people and whose detail is a machine code (Section 8.3 conventions).
 * Only the code and message are logged: `details` of constraint errors can contain row data.
 */
export function fromPgError(err: PgErrorLike, context = 'db'): HttpError {
  const machine = err.details ?? undefined;
  if (err.code === 'P0001') {
    const status = machine === 'forbidden' ? 403 : machine === 'not_found' ? 404 : machine === 'rate_limited' ? 429 : 400;
    return new HttpError(status, err.message || GENERIC_ERROR, machine || 'invalid', parseHint(err.hint));
  }
  console.error(`[${context}] database error`, err.code ?? 'unknown', err.message ?? '');
  if (err.code === '42501') return new HttpError(403, 'Not allowed.', 'forbidden');
  if (err.code === '23505') return new HttpError(409, 'This already exists.', 'conflict');
  return new HttpError(500, GENERIC_ERROR, 'internal');
}

/** Throw unless the request uses one of the allowed methods. */
export function allowMethods(req: Request, methods: readonly string[]): void {
  if (!methods.includes(req.method)) {
    throw new HttpError(405, 'Method not allowed.', 'method_not_allowed');
  }
}

/** Parse a JSON object body, or throw a 400. */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    const text = await req.text();
    body = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'Send the request as JSON.', 'bad_request');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Send the request as a JSON object.', 'bad_request');
  }
  return body as Record<string, unknown>;
}

/** Parse a multipart/form-data body, or throw a 400. */
export async function readForm(req: Request): Promise<FormData> {
  const type = req.headers.get('content-type') ?? '';
  if (!type.toLowerCase().startsWith('multipart/form-data')) {
    throw new HttpError(400, 'Send the files as a form upload.', 'bad_request');
  }
  try {
    return await req.formData();
  } catch {
    throw new HttpError(400, "Couldn't read the upload. Try again.", 'bad_request');
  }
}

/** Reject bodies over a size before reading them (uploads are buffered in memory). */
export function enforceBodyLimit(req: Request, maxBytes: number): void {
  const length = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(length) && length > maxBytes) {
    throw new HttpError(413, 'The upload is too large. Each file can be up to 10 MB.', 'too_large');
  }
}

// ---------------------------------------------------------------- small input helpers

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A trimmed string, or '' for anything that is not a string. */
export function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** A trimmed string, or null when empty / not a string. */
export function optStr(value: unknown): string | null {
  const s = str(value);
  return s === '' ? null : s;
}

/** A UUID (lower-cased), or null when empty. Throws 400 when present but malformed. */
export function optUuid(value: unknown, field: string): string | null {
  const s = optStr(value);
  if (s === null) return null;
  if (!UUID_RE.test(s)) throw new HttpError(400, 'Invalid reference.', 'invalid', { [field]: 'Invalid id.' });
  return s.toLowerCase();
}

export function requireUuid(value: unknown, field: string, notFoundMessage = 'Not found.'): string {
  const s = optUuid(value, field);
  if (s === null) throw new HttpError(404, notFoundMessage, 'not_found');
  return s;
}

// ---------------------------------------------------------------- handler wrapper

/**
 * Wrap a request handler: answers CORS preflight, turns HttpError into JSON error responses
 * and anything unexpected into a generic 500 (logged without request data).
 */
export function handler(name: string, fn: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    if (req.method === 'OPTIONS') {
      return new Response('ok', { status: 200, headers: corsHeaders });
    }
    try {
      return await fn(req);
    } catch (err) {
      if (err instanceof HttpError) {
        return errorResponse(err.status, err.message, err.code, err.hint);
      }
      const e = err as { name?: string; message?: string };
      console.error(`[${name}] unexpected error`, e?.name ?? 'Error', e?.message ?? String(err));
      return errorResponse(500, GENERIC_ERROR, 'internal');
    }
  };
}
