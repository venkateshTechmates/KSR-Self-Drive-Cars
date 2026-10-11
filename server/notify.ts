// Sends queued outbox emails through server/mailer.ts. CONTRACT STUB.

/** Send up to `limit` pending outbox messages; returns counts. */
export async function drainOutbox(_limit = 50): Promise<{ picked: number; sent: number; failed: number; skipped: number; retrying: number }> {
  return { picked: 0, sent: 0, failed: 0, skipped: 0, retrying: 0 };
}

/** Drain soon, without making the caller wait (after queuing an urgent email). */
export function drainSoon(): void {}
