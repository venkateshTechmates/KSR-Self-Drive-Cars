// Turn database, edge-function and network errors into messages people can act on.
// Server business errors carry: message = human text, details = machine code, hint = optional JSON.

export class AppError extends Error {
  code: string | null;
  hint: unknown;
  status: number | null;

  constructor(message: string, code: string | null = null, hint: unknown = null, status: number | null = null) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.hint = hint;
    this.status = status;
  }
}

const FRIENDLY_BY_PG_CODE: Record<string, string> = {
  '42501': "You don't have permission to do that.",
  '23505': 'That already exists.',
  '23P01': 'This car is already booked at that time.',
  '23503': 'This is still linked to other records, so it cannot be removed.',
  '23514': 'Some details are not valid. Check the form and try again.',
  PGRST301: 'Your session has expired. Sign in again.',
};

interface PgLikeError {
  message?: string;
  details?: string | null;
  detail?: string | null;
  hint?: string | null;
  code?: string;
  status?: number;
}

function parseHint(hint: string | null | undefined): unknown {
  if (!hint) return null;
  try {
    return JSON.parse(hint);
  } catch {
    return hint;
  }
}

/** Normalise any thrown value (PostgrestError, AppError, TypeError from fetch) into an AppError. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof TypeError && /fetch|network|load failed/i.test(err.message)) {
    return new AppError("Couldn't reach the server. Check your connection and try again.", 'network');
  }
  const e = (err ?? {}) as PgLikeError;
  const code = e.details ?? e.detail ?? null;
  // P0001 = raised by our SQL functions with a message written for people.
  if (e.code === 'P0001' && e.message) return new AppError(e.message, code, parseHint(e.hint));
  if (e.code && FRIENDLY_BY_PG_CODE[e.code]) return new AppError(FRIENDLY_BY_PG_CODE[e.code], e.code);
  if (e.message) return new AppError(e.message, code, parseHint(e.hint), e.status ?? null);
  return new AppError('Something went wrong. Try again.');
}

export const errorMessage = (err: unknown) => toAppError(err).message;

/** Throw if an API result carries an error; return the data otherwise. */
export function unwrap<T>(result: { data: T | null; error: unknown }): T {
  if (result.error) throw toAppError(result.error);
  return result.data as T;
}
