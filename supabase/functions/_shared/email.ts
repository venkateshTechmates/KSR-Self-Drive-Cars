// Transactional email through the Resend REST API (Section 9.1).
// Needs RESEND_API_KEY and NOTIFY_FROM_EMAIL (e.g. "KSR Self Drive Cars <alerts@example.com>").
import { env } from './env.ts';

export interface EmailMessage {
  to: string[];
  subject: string;
  text: string;
  /** Resend de-duplicates sends with the same key for 24 hours, so retries never double-send. */
  idempotencyKey?: string;
}

export type EmailResult =
  | { ok: true; id: string | null }
  | { ok: false; error: string; status: number | null }
  | { skipped: true; reason: string };

const RESEND_URL = 'https://api.resend.com/emails';
/** Resend accepts at most 50 recipients per email. */
const MAX_RECIPIENTS = 50;

export function emailConfigured(): boolean {
  return Boolean(env('RESEND_API_KEY') && env('NOTIFY_FROM_EMAIL'));
}

export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  const apiKey = env('RESEND_API_KEY');
  const from = env('NOTIFY_FROM_EMAIL');
  if (!apiKey || !from) return { skipped: true, reason: 'Email provider not configured' };

  const recipients = [...new Set(message.to.map((r) => r.trim()).filter(Boolean))];
  if (recipients.length === 0) return { skipped: true, reason: 'No recipients' };

  let lastId: string | null = null;
  for (let i = 0; i < recipients.length; i += MAX_RECIPIENTS) {
    const chunk = recipients.slice(i, i + MAX_RECIPIENTS);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
    if (message.idempotencyKey) {
      headers['Idempotency-Key'] = `${message.idempotencyKey}:${i / MAX_RECIPIENTS}`.slice(0, 256);
    }
    let res: Response;
    try {
      res = await fetch(RESEND_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ from, to: chunk, subject: message.subject.slice(0, 900), text: message.text }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      const e = err as { name?: string; message?: string };
      return { ok: false, error: `Email request failed: ${e?.name ?? 'Error'}`, status: null };
    }
    const body = (await res.json().catch(() => null)) as { id?: string; message?: string; name?: string } | null;
    if (!res.ok) {
      const reason = body?.message ?? body?.name ?? res.statusText;
      return { ok: false, error: `Email provider error ${res.status}: ${String(reason).slice(0, 300)}`, status: res.status };
    }
    lastId = body?.id ?? lastId;
  }
  return { ok: true, id: lastId };
}
