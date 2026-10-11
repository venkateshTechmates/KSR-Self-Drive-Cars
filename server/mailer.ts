// SMTP email (Gmail, Zoho, Outlook or any provider). Without SMTP settings, messages are
// written to the server log instead so invite and reset links can still be copied.
import nodemailer, { type Transporter } from 'nodemailer';
import { config, smtpConfigured } from './config.ts';

let transport: Transporter | null = null;

function getTransport(): Transporter {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  return transport;
}

export interface MailResult {
  sent: boolean;
  /** Why it wasn't sent (not configured), or the provider's error. */
  error?: string;
}

export async function sendMail(to: string[], subject: string, text: string): Promise<MailResult> {
  const recipients = [...new Set(to.filter(Boolean))];
  if (!recipients.length) return { sent: false, error: 'No recipients' };
  if (!smtpConfigured()) {
    console.info(`[mail] SMTP not configured; would send to ${recipients.join(', ')}:\n  Subject: ${subject}\n  ${text.replace(/\n/g, '\n  ')}`);
    return { sent: false, error: 'Email is not configured (set SMTP_HOST)' };
  }
  try {
    await getTransport().sendMail({ from: config.smtp.from, to: recipients.join(', '), subject, text });
    return { sent: true };
  } catch (err) {
    return { sent: false, error: (err as Error).message.slice(0, 300) };
  }
}
