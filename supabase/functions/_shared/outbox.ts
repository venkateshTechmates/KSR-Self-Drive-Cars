// Outbox delivery (Section 11). SQL enqueues messages in `outbox`; this sends them.
// Used by the `notify` function (cron) and inline, in the background, right after enqueuing.
//
// Concurrency: a row is claimed by bumping `attempts` with an optimistic filter on the value
// read, so two drainers never send the same attempt. A failed row waits RETRY_AFTER_MS before
// the next try (its `updated_at` is the time of the failure) and is marked failed after
// MAX_ATTEMPTS. Email sends also carry an idempotency key, so a retry after a timeout that
// actually succeeded is not delivered twice.
import { runInBackground } from './background.ts';
import type { Client } from './clients.ts';
import { emailConfigured, sendEmail } from './email.ts';
import { siteUrl } from './env.ts';

export const MAX_ATTEMPTS = 5;
const RETRY_AFTER_MS = 2 * 60_000;
/** Keep under the email provider's per-second rate limit. */
const SEND_SPACING_MS = 550;

export type OutboxChannel = 'email' | 'whatsapp' | 'sms';

export interface OutboxRow {
  id: string;
  kind: string;
  channel: OutboxChannel;
  recipients: string[];
  subject: string;
  body: string;
  payload: Record<string, unknown> | null;
  attempts: number;
}

type SendOutcome =
  | { status: 'sent' }
  | { status: 'skipped'; reason: string }
  | { status: 'error'; error: string; rateLimited?: boolean };

type ChannelSender = {
  /** False when the provider isn't set up; rows are then marked skipped. */
  configured: () => boolean;
  send: (row: OutboxRow) => Promise<SendOutcome>;
};

/** Full message text: the body plus a link into the admin when the payload has a path. */
export function messageText(row: Pick<OutboxRow, 'body' | 'payload'>): string {
  const path = typeof row.payload?.path === 'string' ? row.payload.path : '';
  const site = siteUrl();
  return path && site ? `${row.body}\n\nOpen: ${site}${path}` : row.body;
}

const emailSender: ChannelSender = {
  configured: emailConfigured,
  async send(row) {
    const result = await sendEmail({
      to: row.recipients,
      subject: row.subject,
      text: messageText(row),
      idempotencyKey: `ksr-outbox-${row.id}`,
    });
    if ('skipped' in result) return { status: 'skipped', reason: result.reason };
    if (result.ok) return { status: 'sent' };
    return { status: 'error', error: result.error, rateLimited: result.status === 429 };
  },
};

/**
 * One sender per channel. Only email is implemented (P0).
 * Extension point (P2): add `whatsapp` (WhatsApp Business API template messages) and `sms`
 * (gateway with DLT-registered templates) here with the same { configured, send } shape.
 * Rows for channels without a sender are marked skipped.
 */
const SENDERS: Partial<Record<OutboxChannel, ChannelSender>> = {
  email: emailSender,
};

export interface DrainResult {
  picked: number;
  sent: number;
  /** Failed this time; will be retried. */
  retrying: number;
  /** Gave up after MAX_ATTEMPTS. */
  failed: number;
  skipped: number;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function drainOutbox(service: Client, limit = 50): Promise<DrainResult> {
  const result: DrainResult = { picked: 0, sent: 0, retrying: 0, failed: 0, skipped: 0 };
  const cutoff = new Date(Date.now() - RETRY_AFTER_MS).toISOString();
  const { data, error } = await service
    .from('outbox')
    .select('id, kind, channel, recipients, subject, body, payload, attempts')
    .eq('status', 'pending')
    .or(`attempts.eq.0,updated_at.lt."${cutoff}"`)
    .order('created_at', { ascending: true })
    .limit(Math.max(1, Math.min(limit, 200)));
  if (error) throw new Error(`outbox read failed: ${error.code ?? ''} ${error.message ?? ''}`);
  const rows = (data ?? []) as OutboxRow[];
  result.picked = rows.length;

  let sentSomething = false;
  for (const row of rows) {
    const sender = SENDERS[row.channel];
    if (!sender || !sender.configured()) {
      const reason = !sender ? `The ${row.channel} channel is not set up yet` : 'Email provider not configured';
      if (await finish(service, row, { status: 'skipped', last_error: reason })) result.skipped++;
      continue;
    }
    if (!row.recipients || row.recipients.length === 0) {
      if (await finish(service, row, { status: 'skipped', last_error: 'No recipients' })) result.skipped++;
      continue;
    }

    // Claim this attempt.
    const attempt = row.attempts + 1;
    const { data: claimed, error: claimError } = await service
      .from('outbox')
      .update({ attempts: attempt })
      .eq('id', row.id)
      .eq('status', 'pending')
      .eq('attempts', row.attempts)
      .select('id');
    if (claimError) {
      console.error('[outbox] claim failed', claimError.code ?? '', claimError.message ?? '');
      continue;
    }
    if (!claimed || claimed.length === 0) continue; // another drainer has it

    if (sentSomething) await delay(SEND_SPACING_MS);
    sentSomething = true;

    let outcome: SendOutcome;
    try {
      outcome = await sender.send(row);
    } catch (err) {
      const e = err as { name?: string; message?: string };
      outcome = { status: 'error', error: `${e?.name ?? 'Error'}: ${e?.message ?? 'send failed'}`.slice(0, 500) };
    }

    if (outcome.status === 'sent') {
      await update(service, row.id, { status: 'sent', sent_at: new Date().toISOString(), last_error: null });
      result.sent++;
    } else if (outcome.status === 'skipped') {
      await update(service, row.id, { status: 'skipped', last_error: outcome.reason });
      result.skipped++;
    } else {
      const giveUp = attempt >= MAX_ATTEMPTS;
      await update(service, row.id, { status: giveUp ? 'failed' : 'pending', last_error: outcome.error.slice(0, 500) });
      if (giveUp) result.failed++;
      else result.retrying++;
      console.error('[outbox] send failed', row.kind, `attempt ${attempt}/${MAX_ATTEMPTS}`);
      // The provider is throttling us: leave the rest for the next run.
      if (outcome.rateLimited) break;
    }
  }
  return result;
}

/** Close a row that was never claimed (skips), only if nobody else touched it. */
async function finish(
  service: Client,
  row: OutboxRow,
  values: { status: 'skipped'; last_error: string },
): Promise<boolean> {
  const { data, error } = await service
    .from('outbox')
    .update(values)
    .eq('id', row.id)
    .eq('status', 'pending')
    .eq('attempts', row.attempts)
    .select('id');
  if (error) {
    console.error('[outbox] update failed', error.code ?? '', error.message ?? '');
    return false;
  }
  return (data ?? []).length > 0;
}

async function update(service: Client, id: string, values: Record<string, unknown>): Promise<void> {
  const { error } = await service.from('outbox').update(values).eq('id', id);
  if (error) console.error('[outbox] update failed', error.code ?? '', error.message ?? '');
}

/** Send what was just enqueued without delaying the response. */
export function drainOutboxInBackground(service: Client, name: string, limit = 10): void {
  runInBackground(name, drainOutbox(service, limit));
}
