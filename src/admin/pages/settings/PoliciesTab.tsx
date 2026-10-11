// Policies (SET-03, WEB-10, DP-07): Privacy notice, Terms and Cancellation policy in English,
// Telugu and Hindi. Publishing always inserts a new version; old versions are never edited
// because customers' consents point to the version they agreed to.
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Eye } from 'lucide-react';
import { LOCALE_LABELS, LOCALES, POLICY_LABELS, POLICY_KINDS, type Locale, type PolicyKind } from '@shared/constants.ts';
import { Badge } from '@/components/ui/Badges';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog';
import { Alert, Checkbox, Field, Input, Textarea } from '@/components/ui/Field';
import { Card, CardBody, CardHeader, Chip } from '@/components/ui/Layout';
import { api } from '@/integrations/api/client';
import { cn } from '@/lib/cn';
import { toAppError, unwrap } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import type { PolicyVersion } from '@/types/db';
import { useAuth } from '../../auth/AuthProvider';
import { qk, useSetting, useStaffName } from '../../hooks/queries';
import { Loader } from './FormParts';
import { fillPolicy, policyValues, POLICY_PLACEHOLDERS, PROSE, renderMarkdown } from './markdown';

const policyKey = [...qk.settings, 'policy_versions'] as const;

interface Draft {
  title: string;
  body: string;
}

export function PoliciesTab() {
  const versions = useQuery({
    queryKey: policyKey,
    queryFn: async () => unwrap(await api.from('policy_versions').select('*').order('version', { ascending: false })) as PolicyVersion[],
  });
  return <Loader query={versions}>{(rows) => <Policies rows={rows} />}</Loader>;
}

function Policies({ rows }: { rows: PolicyVersion[] }) {
  const staffName = useStaffName();
  const business = useSetting('business');
  const rules = useSetting('booking_rules');
  const [kind, setKind] = useState<PolicyKind>('privacy');
  const [locale, setLocale] = useState<Locale>('en');
  // Unpublished edits per policy and language, so switching tabs doesn't lose them.
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [viewing, setViewing] = useState<PolicyVersion | null>(null);

  const values = policyValues(business.data, rules.data);
  const versionsOf = (k: PolicyKind, l: Locale) => rows.filter((r) => r.kind === k && r.locale === l);
  const list = versionsOf(kind, locale);
  const current = list[0] ?? null;
  const english = versionsOf(kind, 'en')[0] ?? null;
  const draftKey = `${kind}:${locale}`;
  const start = current ?? english;
  const draft = drafts[draftKey] ?? { title: start?.title ?? POLICY_LABELS[kind], body: start?.body_md ?? '' };
  const by = (v: PolicyVersion) => (v.published_by ? staffName(v.published_by) : 'Set up with the site');

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader title="Policies" description="Shown on the website and linked from the booking form. Customers agree to the version that is current when they book." />
        <CardBody className="flex flex-col gap-4">
          <div role="group" aria-label="Policy" className="flex flex-wrap gap-2">
            {POLICY_KINDS.map((k) => (
              <Chip key={k} pressed={kind === k} onClick={() => setKind(k)}>
                {POLICY_LABELS[k]}
              </Chip>
            ))}
          </div>
          <div role="group" aria-label="Language" className="flex flex-wrap gap-2">
            {LOCALES.map((l) => {
              const v = versionsOf(kind, l)[0];
              return (
                <Chip key={l} pressed={locale === l} onClick={() => setLocale(l)}>
                  <span lang={l}>{LOCALE_LABELS[l]}</span>
                  <span className="font-medium opacity-80">{v ? `v${v.version}` : 'none'}</span>
                </Chip>
              );
            })}
          </div>
          <p className="m-0 text-sm text-muted">
            Placeholders are filled from Settings on the public page:{' '}
            {POLICY_PLACEHOLDERS.map((p, i) => (
              <span key={p}>
                <code className="rounded bg-subtle px-1">{`{${p}}`}</code>
                {i < POLICY_PLACEHOLDERS.length - 1 ? ' ' : ''}
              </span>
            ))}
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={`Current ${POLICY_LABELS[kind].toLowerCase()} (${LOCALE_LABELS[locale]})`}
          description={current ? `Version ${current.version} · published ${formatDateTime(current.published_at)} by ${by(current)}` : undefined}
        />
        <CardBody>
          {current ? (
            <div className="max-h-96 overflow-y-auto rounded-xl border border-line-card bg-subtle px-4 py-3">
              <h3 className="m-0 mb-2 text-xl font-bold" lang={locale}>
                {current.title}
              </h3>
              <div lang={locale} className={PROSE} dangerouslySetInnerHTML={{ __html: renderMarkdown(fillPolicy(current.body_md, values)) }} />
            </div>
          ) : (
            <Alert tone="warning" title={`No ${LOCALE_LABELS[locale]} version yet`}>
              Publish one below so customers can read the {POLICY_LABELS[kind].toLowerCase()} in this language (DP-07). The editor starts from the English text for
              you to translate.
            </Alert>
          )}
        </CardBody>
      </Card>

      <PolicyEditor
        key={draftKey}
        kind={kind}
        locale={locale}
        current={current}
        draft={draft}
        values={values}
        onChange={(d) => setDrafts((all) => ({ ...all, [draftKey]: d }))}
        onPublished={() =>
          setDrafts((all) => {
            const next = { ...all };
            delete next[draftKey];
            return next;
          })
        }
      />

      {list.length > 1 && (
        <Card>
          <CardHeader title="Earlier versions" description="Kept unchanged because customers' consents refer to them." />
          <CardBody>
            <ul className="m-0 flex list-none flex-col divide-y divide-line-card p-0">
              {list.slice(1).map((v) => (
                <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    <span className="font-semibold">Version {v.version}</span>
                    <span className="text-muted">
                      {' '}
                      · {formatDateTime(v.published_at)} · {by(v)}
                    </span>
                  </span>
                  <Button variant="ghost" size="sm" icon={<Eye size={16} aria-hidden="true" />} onClick={() => setViewing(v)} aria-label={`View version ${v.version}`}>
                    View
                  </Button>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      <Dialog
        open={viewing !== null}
        onClose={() => setViewing(null)}
        size="lg"
        title={viewing ? `${POLICY_LABELS[viewing.kind]} · version ${viewing.version}` : 'Version'}
        description={viewing ? `${LOCALE_LABELS[viewing.locale as Locale] ?? viewing.locale} · published ${formatDateTime(viewing.published_at)}. Read-only.` : undefined}
      >
        {viewing && (
          <>
            <h3 className="m-0 mb-2 text-xl font-bold" lang={viewing.locale}>
              {viewing.title}
            </h3>
            <div lang={viewing.locale} className={PROSE} dangerouslySetInnerHTML={{ __html: renderMarkdown(viewing.body_md) }} />
          </>
        )}
      </Dialog>
    </div>
  );
}

function PolicyEditor({
  kind,
  locale,
  current,
  draft,
  values,
  onChange,
  onPublished,
}: {
  kind: PolicyKind;
  locale: Locale;
  current: PolicyVersion | null;
  draft: Draft;
  values: Record<string, string>;
  onChange: (d: Draft) => void;
  onPublished: () => void;
}) {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [fill, setFill] = useState(true);
  const [errors, setErrors] = useState<{ title?: string; body?: string }>({});
  const [confirming, setConfirming] = useState(false);
  const nextVersion = (current?.version ?? 0) + 1;
  const unchanged = Boolean(current && current.title === draft.title.trim() && current.body_md === draft.body.trim());

  function insert(p: string) {
    const el = bodyRef.current;
    const token = `{${p}}`;
    if (!el) return onChange({ ...draft, body: draft.body + token });
    const { selectionStart: s, selectionEnd: e } = el;
    onChange({ ...draft, body: draft.body.slice(0, s) + token + draft.body.slice(e) });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s + token.length, s + token.length);
    });
  }

  function check(): boolean {
    const next: typeof errors = {};
    const t = draft.title.trim();
    if (t.length < 3 || t.length > 120) next.title = 'Enter a title of 3 to 120 characters.';
    if (draft.body.trim().length < 20) next.body = 'Write the policy text (at least a couple of sentences).';
    else if (unchanged) next.body = `Nothing has changed since version ${current?.version}. Edit the text before publishing.`;
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function publish() {
    const { error } = await api.from('policy_versions').insert({
      kind,
      locale,
      version: nextVersion,
      title: draft.title.trim(),
      body_md: draft.body.trim(),
      published_by: session?.user.id ?? null,
    });
    if (error) {
      const appErr = toAppError(error);
      if (appErr.code === '23505') throw new Error('Someone else published a version just now. Reload the page and try again.');
      throw appErr;
    }
    toast.success(`Published version ${nextVersion} of the ${POLICY_LABELS[kind].toLowerCase()} (${LOCALE_LABELS[locale]}).`);
    onPublished();
    await queryClient.invalidateQueries({ queryKey: policyKey });
  }

  const preview = renderMarkdown(fill ? fillPolicy(draft.body, values) : draft.body);

  return (
    <Card>
      <CardHeader
        title={`Publish version ${nextVersion}`}
        description="Write in Markdown: ## for headings, - for bullet points, **bold**. The preview shows what customers will see."
        actions={<Badge tone="outline">{LOCALE_LABELS[locale]}</Badge>}
      />
      <CardBody className="flex flex-col gap-4">
        <Field label="Title" required error={errors.title}>
          <Input value={draft.title} onChange={(e) => onChange({ ...draft, title: e.target.value })} maxLength={120} lang={locale} />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted">Insert:</span>
          {POLICY_PLACEHOLDERS.map((p) => (
            <Button key={p} variant="ghost" size="sm" onClick={() => insert(p)} className="font-mono text-[13px]">
              {`{${p}}`}
            </Button>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Field label="Text (Markdown)" required error={errors.body}>
            <Textarea
              ref={bodyRef}
              value={draft.body}
              onChange={(e) => onChange({ ...draft, body: e.target.value })}
              rows={22}
              lang={locale}
              className="font-mono text-[14px]"
              spellCheck={locale === 'en'}
            />
          </Field>
          <section aria-label="Preview" className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="m-0 font-semibold">Preview</p>
              <Checkbox label="Fill placeholders from Settings" checked={fill} onChange={(e) => setFill(e.target.checked)} />
            </div>
            <div className={cn('max-h-[560px] min-h-40 overflow-y-auto rounded-xl border border-line-card bg-surface px-4 py-3')}>
              <h3 className="m-0 mb-2 text-xl font-bold" lang={locale}>
                {draft.title || 'Untitled'}
              </h3>
              <div lang={locale} className={PROSE} dangerouslySetInnerHTML={{ __html: preview }} />
            </div>
          </section>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <p className="m-0 mr-auto text-sm text-muted">Published versions can't be changed. To fix a mistake, publish another version.</p>
          <Button onClick={() => check() && setConfirming(true)}>Publish version {nextVersion}</Button>
        </div>
      </CardBody>

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={publish}
        title={`Publish version ${nextVersion}?`}
        description={`The ${POLICY_LABELS[kind].toLowerCase()} in ${LOCALE_LABELS[locale]} changes on the website straight away, and new bookings record this version with the customer's consent. Earlier versions stay as they are.`}
        confirmLabel="Publish"
      />
    </Card>
  );
}
