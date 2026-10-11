// BKA-08: one-tap Call and WhatsApp for the customer, plus WhatsApp templates (SET-04).
import { useId, useRef, useState } from 'react';
import { ChevronDown, MessageCircle, MessageSquareText, Phone } from 'lucide-react';
import { DEFAULT_SETTINGS, fillTemplate, type MessageTemplates } from '@shared/settings.ts';
import { AnchorButton, Button } from '@/components/ui/Button';
import { telHref, whatsappHref } from '@/lib/format';
import type { BookingWithRefs } from '@/types/db';
import { useSetting } from '@/admin/hooks/queries';
import { templateValues } from './helpers';

const TEMPLATES: Array<{ key: keyof MessageTemplates; label: string }> = [
  { key: 'confirmation', label: 'Booking confirmed' },
  { key: 'reminder', label: 'Pickup reminder' },
  { key: 'directions', label: 'Directions' },
  { key: 'rejection', label: 'Could not confirm' },
];

export function ContactActions({ booking }: { booking: BookingWithRefs }) {
  const templates = useSetting('templates').data ?? DEFAULT_SETTINGS.templates;
  const business = useSetting('business').data ?? DEFAULT_SETTINGS.business;
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const phone = booking.customer?.phone;
  if (!phone) return null;

  const values = templateValues(booking, business);
  const name = booking.customer?.full_name ?? 'the customer';

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          setOpen(false);
          buttonRef.current?.focus();
        }
      }}
    >
      <AnchorButton href={telHref(phone)} variant="secondary" size="sm" icon={<Phone size={16} aria-hidden="true" />} aria-label={`Call ${name}`}>
        Call
      </AnchorButton>
      <AnchorButton
        href={whatsappHref(phone)}
        target="_blank"
        rel="noopener noreferrer"
        variant="secondary"
        size="sm"
        icon={<MessageCircle size={16} aria-hidden="true" />}
        aria-label={`WhatsApp ${name} (opens WhatsApp)`}
      >
        WhatsApp
      </AnchorButton>
      <div className="relative">
        <Button
          ref={buttonRef}
          variant="secondary"
          size="sm"
          icon={<MessageSquareText size={16} aria-hidden="true" />}
          aria-expanded={open}
          aria-controls={menuId}
          onClick={() => setOpen((o) => !o)}
        >
          Message templates
          <ChevronDown size={16} aria-hidden="true" className={open ? 'rotate-180' : undefined} />
        </Button>
        {open && (
          <ul
            id={menuId}
            aria-label="Send a WhatsApp message"
            className="absolute left-0 z-30 m-0 mt-2 sm:right-0 sm:left-auto flex w-[min(22rem,calc(100vw-2rem))] list-none flex-col gap-0.5 rounded-xl border border-line-card bg-surface p-1 shadow-xl"
          >
            {TEMPLATES.map((t) => {
              const text = fillTemplate(templates[t.key] ?? '', values);
              return (
                <li key={t.key}>
                  <a
                    href={whatsappHref(phone, text)}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => setOpen(false)}
                    className="flex min-h-11 flex-col justify-center rounded-lg px-3 py-2 text-ink no-underline hover:bg-subtle hover:text-ink"
                  >
                    <span className="font-semibold">{t.label}</span>
                    <span className="line-clamp-2 text-sm text-muted">{text}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
