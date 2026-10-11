// Tap-to-call link for a customer's mobile (DSH-02, BKA-08). Stops the click reaching a clickable row.
import { Phone } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatPhone, telHref } from '@/lib/format';

export function CallLink({
  phone,
  name,
  showNumber = true,
  className,
}: {
  phone: string | null | undefined;
  name?: string | null;
  /** Show the number next to the icon (from the sm breakpoint when 'sm'). */
  showNumber?: boolean | 'sm';
  className?: string;
}) {
  if (!phone) return null;
  const label = `Call ${name ? `${name} on ` : ''}${formatPhone(phone)}`;
  return (
    <a
      href={telHref(phone)}
      aria-label={label}
      title={label}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-full border border-line-input bg-white px-3 font-semibold whitespace-nowrap text-ink no-underline hover:border-ink hover:text-ink',
        className,
      )}
    >
      <Phone size={16} aria-hidden="true" />
      {showNumber && <span className={cn(showNumber === 'sm' && 'hidden sm:inline')}>{formatPhone(phone)}</span>}
    </a>
  );
}
