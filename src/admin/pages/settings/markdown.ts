// Markdown → sanitised HTML for the policy preview. Same libraries as the public policy pages.
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { formatPhone } from '@shared/validation.ts';
import { fillTemplate, type BookingRules, type BusinessSettings } from '@shared/settings.ts';

export function renderMarkdown(md: string): string {
  const html = marked.parse(md, { async: false, gfm: true }) as string;
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

/** Placeholders the public policy pages fill from Settings. */
export const POLICY_PLACEHOLDERS = ['phone', 'email', 'address', 'grievance_name', 'grievance_email', 'grievance_phone', 'fuel_policy'] as const;

export function policyValues(business: BusinessSettings | undefined, rules: BookingRules | undefined): Record<string, string> {
  return {
    phone: formatPhone(business?.phone),
    email: business?.email ?? '',
    address: business?.address ?? '',
    grievance_name: business?.grievance_name ?? '',
    grievance_email: business?.grievance_email ?? '',
    grievance_phone: formatPhone(business?.grievance_phone),
    fuel_policy: rules?.fuel_policy ?? '',
  };
}

export const fillPolicy = (md: string, values: Record<string, string>) => fillTemplate(md, values);

/** Tailwind classes that give rendered markdown readable spacing without a typography plugin. */
export const PROSE =
  'text-[15px] leading-relaxed text-ink [&_a]:underline [&_blockquote]:border-l-4 [&_blockquote]:border-line [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-subtle [&_code]:px-1 [&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-2xl [&_h1]:font-extrabold [&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-xl [&_h2]:font-bold [&_h3]:mt-4 [&_h3]:mb-1 [&_h3]:text-lg [&_h3]:font-bold [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-2 [&_table]:border-collapse [&_td]:border [&_td]:border-line [&_td]:px-2 [&_th]:border [&_th]:border-line [&_th]:px-2 [&_ul]:list-disc [&_ul]:pl-6 [&>*:first-child]:mt-0';
