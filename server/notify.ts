// Outbox delivery (Section 11): business code queues messages with server/outbox.ts; this
// sends them with server/mailer.ts. Called every minute by the scheduler and, through
// drainSoon(), right after something urgent was queued.
//
// Concurrency: each row is claimed with one conditional UPDATE (status still 'pending' and
// due), which also bumps `attempts` and pushes next_attempt_at out by a lease, so two drains
// never send the same row. A failed send is retried after RETRY_AFTER_MS and marked 'failed'
// after MAX_ATTEMPTS. Nothing personal is logged: only the message kind and attempt count.
import { config, smtpConfigured } from './config.ts';
import { nowIso, one, run } from './db/connection.ts';
import { sendMail } from './mailer.ts';

export const MAX_ATTEMPTS = 5;
const RETRY_AFTER_MS = 2 * 60_000;
/** A claimed row is left alone by other drains for this long (covers slow SMTP servers). */
const CLAIM_LEASE_MS = 15 * 60_000;
const NOT_CONFIGURED = 'Email is not configured';

export interface DrainResult {
  picked: number;
  sent: number;
  /** Gave up after MAX_ATTEMPTS. */
  failed: number;
  skipped: number;
  /** Failed this time; will be retried. */
  retrying: number;
}

interface ClaimedRow {
  id: string;
  kind: string;
  channel: string;
  recipients: string;
  subject: string;
  body: string;
  payload: string;
  attempts: number;
}

const later = (ms: number) => new Date(Date.now() + ms).toISOString();

function parseJson<T>(text: string, fallback: T): T {
  try {
    const v = JSON.parse(text) as unknown;
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}

/** Claim the oldest due pending row, or undefined when there is none. */
function claimNext(): ClaimedRow | undefined {
  const now = nowIso();
  return one<ClaimedRow>(
    `UPDATE outbox SET attempts = attempts + 1, next_attempt_at = ?, updated_at = ?
      WHERE id = (SELECT id FROM outbox
                   WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
                   ORDER BY created_at, id LIMIT 1)
        AND status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      RETURNING id, kind, channel, recipients, subject, body, payload, attempts`,
    later(CLAIM_LEASE_MS),
    now,
    now,
    now,
  );
}

function finish(id: string, status: 'sent' | 'skipped' | 'failed' | 'pending', lastError: string | null): void {
  const now = nowIso();
  run(
    `UPDATE outbox SET status = ?, last_error = ?, sent_at = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`,
    status,
    lastError === null ? null : lastError.slice(0, 500),
    status === 'sent' ? now : null,
    status === 'pending' ? later(RETRY_AFTER_MS) : null,
    now,
    id,
  );
}

/** The body plus a link into the admin when the payload has a path. */
export function messageText(body: string, payload: Record<string, unknown>): string {
  const path = typeof payload.path === 'string' ? payload.path : '';
  return path ? `${body}\n\nOpen: ${config.siteUrl}${path}` : body;
}

/** Send up to `limit` due outbox messages, oldest first; returns counts. */
export async function drainOutbox(limit = 50): Promise<DrainResult> {
  const result: DrainResult = { picked: 0, sent: 0, failed: 0, skipped: 0, retrying: 0 };
  const max = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50;
  for (let i = 0; i < max; i++) {
    const row = claimNext();
    if (!row) break;
    result.picked++;

    const recipients = parseJson<unknown[]>(row.recipients, []).filter((r): r is string => typeof r === 'string' && r.trim() !== '');
    let skipReason: string | null = null;
    if (row.channel !== 'email') skipReason = `The ${row.channel} channel is not set up yet`;
    else if (!smtpConfigured()) skipReason = NOT_CONFIGURED;
    else if (recipients.length === 0) skipReason = 'No recipients';
    if (skipReason) {
      finish(row.id, 'skipped', skipReason);
      result.skipped++;
      continue;
    }

    let error: string | null;
    try {
      const sent = await sendMail(recipients, row.subject, messageText(row.body, parseJson(row.payload, {})));
      error = sent.sent ? null : (sent.error ?? 'Send failed');
    } catch (err) {
      error = `${(err as Error)?.name ?? 'Error'}: ${(err as Error)?.message ?? 'send failed'}`;
    }

    if (error === null) {
      finish(row.id, 'sent', null);
      result.sent++;
    } else if (row.attempts >= MAX_ATTEMPTS) {
      finish(row.id, 'failed', error);
      result.failed++;
      console.error(`[notify] gave up on a ${row.kind} message after ${row.attempts} attempts`);
    } else {
      finish(row.id, 'pending', error);
      result.retrying++;
      console.error(`[notify] could not send a ${row.kind} message (attempt ${row.attempts}/${MAX_ATTEMPTS}); will retry`);
    }
  }
  return result;
}

let timer: ReturnType<typeof setTimeout> | null = null;
const DRAIN_SOON_DELAY_MS = 250;

/** Drain soon, without making the caller wait (after queuing an urgent email). Never throws. */
export function drainSoon(): void {
  try {
    if (timer) return; // a drain is already scheduled; it will pick this message up too
    timer = setTimeout(() => {
      timer = null;
      drainOutbox(20).catch((err: unknown) => {
        console.error('[notify] drain failed:', (err as Error)?.name ?? 'Error', (err as Error)?.message ?? '');
      });
    }, DRAIN_SOON_DELAY_MS);
    timer.unref?.();
  } catch {
    // never let a notification problem break the request that queued it
  }
}
