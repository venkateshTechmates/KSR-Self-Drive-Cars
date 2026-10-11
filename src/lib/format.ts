// One import for display formatting in components.
export { formatRupees, parseRupees, paiseToInput, rupeesToPaise } from '@shared/money.ts';
export {
  formatClock,
  formatDate,
  formatDateTime,
  formatDuration,
  formatIsoDate,
  formatRelativeDay,
  formatWhen,
  istDateIso,
  istTime,
} from '@shared/time.ts';
export { formatPhone, waDigits } from '@shared/validation.ts';
export { formatBytes } from '@shared/documents.ts';

/** "tel:+919876543210" */
export const telHref = (e164: string | null | undefined) => (e164 ? `tel:${e164}` : undefined);

/** wa.me link with an optional pre-filled message. */
export function whatsappHref(e164: string | null | undefined, text?: string): string | undefined {
  if (!e164) return undefined;
  const digits = e164.replace(/\D/g, '');
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

export const pluralize = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
