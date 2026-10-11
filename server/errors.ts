// API errors. Business errors keep the shape the web app already understands
// (src/lib/errors.ts): { message, details: <machine code>, hint, code: 'P0001' }.

export class ApiError extends Error {
  status: number;
  /** Machine-readable code, sent as `details` (e.g. 'clash', 'forbidden', 'pickup'). */
  detail: string | null;
  hint: unknown;
  /** Postgres-style error class the client maps to messages ('P0001' = written for people). */
  pgCode: string;

  constructor(message: string, detail: string | null = null, opts: { status?: number; hint?: unknown; pgCode?: string } = {}) {
    super(message);
    this.name = 'ApiError';
    this.detail = detail;
    this.status = opts.status ?? 400;
    this.hint = opts.hint ?? null;
    this.pgCode = opts.pgCode ?? 'P0001';
  }
}

/** Throw a business-rule error with a message for people and a machine code. */
export function fail(message: string, detail: string | null = null, hint?: unknown, status = 400): never {
  throw new ApiError(message, detail, { status, hint });
}

export const forbidden = (message = 'Not allowed.'): never => {
  throw new ApiError(message, 'forbidden', { status: 403 });
};

export const notFound = (message = 'Not found.'): never => {
  throw new ApiError(message, 'not_found', { status: 404 });
};

const TRIGGER_CODES: Record<string, { detail: string; pgCode: string; status: number }> = {
  bookings_no_overlap: { detail: 'clash', pgCode: 'P0001', status: 409 },
  photo_limit: { detail: 'photo_limit', pgCode: 'P0001', status: 400 },
  audit_immutable: { detail: 'forbidden', pgCode: 'P0001', status: 403 },
  invalid: { detail: 'invalid', pgCode: 'P0001', status: 400 },
};

/** Convert any thrown value into an ApiError (SQLite constraint errors get friendly messages). */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  const message = err instanceof Error ? err.message : String(err);
  // RAISE(ABORT, 'code: message') from triggers
  const trigger = /^(\w+): (.+)$/.exec(message);
  if (trigger && TRIGGER_CODES[trigger[1]]) {
    const t = TRIGGER_CODES[trigger[1]];
    return new ApiError(trigger[2], t.detail, { status: t.status, pgCode: t.pgCode });
  }
  if (/UNIQUE constraint failed/i.test(message)) return new ApiError('That already exists.', 'duplicate', { status: 409, pgCode: '23505' });
  if (/FOREIGN KEY constraint failed/i.test(message))
    return new ApiError('This is still linked to other records, so it cannot be changed or removed.', 'linked', { status: 409, pgCode: '23503' });
  if (/CHECK constraint failed/i.test(message) || /NOT NULL constraint failed/i.test(message))
    return new ApiError('Some details are not valid. Check the form and try again.', 'invalid', { status: 400, pgCode: '23514' });
  console.error('[api] unexpected error:', err);
  return new ApiError('Something went wrong. Try again.', 'internal', { status: 500, pgCode: 'XX000' });
}

export function errorBody(e: ApiError) {
  return {
    message: e.message,
    details: e.detail,
    hint: e.hint === null || e.hint === undefined ? null : typeof e.hint === 'string' ? e.hint : JSON.stringify(e.hint),
    code: e.pgCode,
  };
}
