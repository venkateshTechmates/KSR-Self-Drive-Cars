// Message templates (SET-04) for WhatsApp, SMS and email, with placeholder help and a preview
// filled with sample booking details.
import { useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import { fillTemplate, type BusinessSettings, type MessageTemplates } from '@shared/settings.ts';
import { formatPhone } from '@shared/validation.ts';
import { Field, Textarea } from '@/components/ui/Field';
import { errorMessage } from '@/lib/errors';
import { useSaveSetting, useSetting } from '../../hooks/queries';
import { FormCard, Loader, SaveBar } from './FormParts';
import { Errors, sameJson } from './formUtils';

type Key = keyof MessageTemplates;

const TEMPLATES: Array<{ key: Key; label: string; hint: string }> = [
  { key: 'confirmation', label: 'Booking confirmed', hint: 'Sent when you confirm a booking.' },
  { key: 'reminder', label: 'Pickup reminder', hint: 'Sent before pickup.' },
  { key: 'directions', label: 'Directions', hint: 'How to find the pickup point.' },
  { key: 'upload_link', label: 'Document upload link', hint: 'Sent with a one-time link for the customer to upload documents. Must include {link}.' },
  { key: 'rejection', label: 'Booking not confirmed', hint: 'Sent when you reject a request. Include {reason}.' },
];

const PLACEHOLDERS: Array<[string, string]> = [
  ['name', "Customer's name"],
  ['car', 'Car name'],
  ['package', '12 hrs or 24 hrs'],
  ['pickup', 'Pickup date and time'],
  ['return', 'Return-by date and time'],
  ['code', 'Booking code'],
  ['address', 'Pickup address'],
  ['map', 'Map link'],
  ['phone', 'Business phone'],
  ['link', 'Upload link'],
  ['reason', 'Reason (rejections)'],
];
const KNOWN = new Set(PLACEHOLDERS.map(([p]) => p));
const MAX_LENGTH = 1000;

function sampleValues(business: BusinessSettings | undefined): Record<string, string> {
  return {
    name: 'Priya',
    car: 'Kia Sonet',
    package: '24 hrs',
    pickup: 'Sat, 17 Oct, 9:00 am',
    return: 'Sun, 18 Oct, 9:00 am',
    code: 'KSR-261017-004',
    address: business?.address || '[pickup address]',
    map: business?.map_url || '[map link]',
    phone: formatPhone(business?.phone) || '[business phone]',
    link: 'https://example.com/upload/abc123',
    reason: 'the car is booked at that time',
  };
}

function check(key: Key, text: string): string | null {
  const t = text.trim();
  if (!t) return 'Write the message, or restore the default text.';
  if (t.length > MAX_LENGTH) return `Use ${MAX_LENGTH} characters or fewer.`;
  const unknown = [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((p) => !KNOWN.has(p));
  if (unknown.length) return `Unknown placeholder ${unknown.map((p) => `{${p}}`).join(', ')}. Use one from the list above.`;
  if (key === 'upload_link' && !t.includes('{link}')) return 'Include {link} so the customer gets the upload link.';
  return null;
}

export function TemplatesTab() {
  const query = useSetting('templates');
  return <Loader query={query}>{(data) => <TemplatesForm key={query.dataUpdatedAt} initial={data} />}</Loader>;
}

function TemplatesForm({ initial }: { initial: MessageTemplates }) {
  const save = useSaveSetting('templates');
  const business = useSetting('business');
  const [form, setForm] = useState<MessageTemplates>(initial);
  const [errors, setErrors] = useState<Partial<Record<Key, string>>>({});
  const dirty = !sameJson(form, initial);
  const sample = sampleValues(business.data);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs = new Errors<Key>();
    for (const t of TEMPLATES) errs.set(t.key, check(t.key, form[t.key]));
    setErrors(errs.map);
    if (!errs.ok) {
      toast.error('Some messages need fixing. Check the highlighted fields.');
      return;
    }
    try {
      const value = Object.fromEntries(TEMPLATES.map((t) => [t.key, form[t.key].trim()])) as unknown as MessageTemplates;
      await save.mutateAsync(value);
      toast.success('Message templates saved.');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      <FormCard title="Placeholders" description="Type these in a message; they're replaced with the booking's details when you send it.">
        <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-1 text-[15px] sm:grid-cols-2 lg:grid-cols-3">
          {PLACEHOLDERS.map(([p, label]) => (
            <div key={p} className="flex gap-2">
              <dt>
                <code className="rounded bg-subtle px-1 font-mono text-[14px]">{`{${p}}`}</code>
              </dt>
              <dd className="m-0 text-muted">{label}</dd>
            </div>
          ))}
        </dl>
      </FormCard>

      {TEMPLATES.map((t) => (
        <FormCard key={t.key} title={t.label} description={t.hint}>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Field label="Message" error={errors[t.key]} hint={`${form[t.key].length} of ${MAX_LENGTH} characters`}>
              <Textarea rows={5} value={form[t.key]} onChange={(e) => setForm((f) => ({ ...f, [t.key]: e.target.value }))} />
            </Field>
            <div className="flex min-w-0 flex-col gap-2">
              <p className="m-0 font-semibold">Preview with sample details</p>
              <p className="m-0 rounded-xl border border-line-card bg-subtle px-4 py-3 text-[15px] break-words whitespace-pre-wrap">
                {fillTemplate(form[t.key], sample) || <span className="text-muted">Empty message</span>}
              </p>
            </div>
          </div>
        </FormCard>
      ))}

      <SaveBar dirty={dirty} saving={save.isPending} hasErrors={Object.keys(errors).length > 0 && dirty} />
    </form>
  );
}
