// Privacy notice, Terms of rental and Cancellation policy (WEB-10), in every published
// language (DP-07). Placeholders such as {phone} are filled from Settings.
import { useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { LOCALE_LABELS, POLICY_LABELS, type Locale, type PolicyKind } from '@shared/constants.ts';
import { fillTemplate } from '@shared/settings.ts';
import { formatDate } from '@shared/time.ts';
import { formatPhone } from '@shared/validation.ts';
import { Alert } from '@/components/ui/Field';
import { PageSpinner } from '@/components/ui/Spinner';
import { cn } from '@/lib/cn';
import { errorMessage } from '@/lib/errors';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { SitePage } from '../components/SiteChrome';
import { pickPolicy, usePublicConfig, usePublicPolicies } from '../hooks/publicData';

const DESCRIPTIONS: Record<PolicyKind, string> = {
  privacy: 'How KSR Self Drive Cars collects, uses, keeps and protects your personal data, and how to use your rights.',
  terms: 'Terms for renting a self-drive car from KSR Self Drive Cars.',
  cancellation: 'How to cancel a KSR Self Drive Cars booking, and refunds.',
};

export default function PolicyPage({ kind }: { kind: PolicyKind }) {
  const policies = usePublicPolicies(kind);
  const config = usePublicConfig();
  const [locale, setLocale] = useState<Locale>('en');
  const policy = pickPolicy(policies.data, locale);
  useDocumentMeta({ title: `${POLICY_LABELS[kind]} | KSR Self Drive Cars`, description: DESCRIPTIONS[kind], path: `/${kind}` });

  const html = useMemo(() => {
    if (!policy) return '';
    const b = config.data?.business;
    const filled = fillTemplate(policy.body_md, {
      phone: b?.phone ? formatPhone(b.phone) : '[phone number]',
      email: b?.email || '[email]',
      address: b?.address || '[pickup address]',
      grievance_name: b?.grievance_name || '[grievance officer]',
      grievance_email: b?.grievance_email || '[grievance email]',
      grievance_phone: b?.grievance_phone ? formatPhone(b.grievance_phone) : '[grievance phone]',
      fuel_policy: config.data?.rules.fuel_policy || 'Fuel as per policy.',
    });
    return DOMPurify.sanitize(marked.parse(filled, { async: false }) as string);
  }, [policy, config.data]);

  const available = (policies.data ?? []).map((p) => p.locale as Locale);

  return (
    <SitePage>
      <article className="mx-auto max-w-[760px] px-5 py-10 sm:px-6 md:py-16" lang={policy?.locale ?? 'en'}>
        <h1 className="display m-0 text-[48px] md:text-[64px]">{policy?.title ?? POLICY_LABELS[kind]}</h1>
        {available.length > 1 && (
          <div role="group" aria-label="Language" className="mt-5 flex flex-wrap gap-2">
            {available.map((l) => (
              <button
                key={l}
                type="button"
                aria-pressed={(policy?.locale ?? 'en') === l}
                onClick={() => setLocale(l)}
                lang={l}
                className={cn(
                  'min-h-11 rounded-full border px-4 font-semibold',
                  (policy?.locale ?? 'en') === l ? 'border-ink bg-ink text-white' : 'border-line-input bg-white text-ink',
                )}
              >
                {LOCALE_LABELS[l]}
              </button>
            ))}
          </div>
        )}
        {policies.isLoading && <PageSpinner />}
        {policies.error && <Alert className="mt-6">{errorMessage(policies.error)}</Alert>}
        {policy && (
          <>
            <p className="m-0 mt-4 text-sm text-muted">
              Version {policy.version}, published {formatDate(policy.published_at)}
            </p>
            <div
              className="mt-8 text-[17px] leading-relaxed text-ink-2 [&_a]:font-semibold [&_h2]:mt-10 [&_h2]:mb-3 [&_h2]:text-2xl [&_h2]:font-bold [&_h2]:text-ink [&_li]:mb-2 [&_p]:my-4 [&_ul]:pl-5"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </>
        )}
        {!policies.isLoading && !policy && !policies.error && <Alert tone="info" className="mt-6">This page hasn&apos;t been published yet.</Alert>}
      </article>
    </SitePage>
  );
}
