// Booking lookup (5.5): booking code + mobile number → status and pickup details. No documents shown.
import { useState, type FormEvent } from 'react';
import { formatWhen } from '@shared/time.ts';
import { normalizePhone, validatePhone } from '@shared/validation.ts';
import { Button } from '@/components/ui/Button';
import { Alert, Field, Input } from '@/components/ui/Field';
import { api } from '@/integrations/api/client';
import { errorMessage } from '@/lib/errors';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { SitePage, useContact } from '../components/SiteChrome';

interface LookupResult {
  found: boolean;
  code?: string;
  status?: string;
  car?: string;
  package?: string;
  pickup_at?: string;
  return_due_at?: string;
}

export default function LookupPage() {
  useDocumentMeta({ title: 'Check a booking | KSR Self Drive Cars', description: 'See the status of your KSR Self Drive Cars booking request.', path: '/booking-status', noindex: true });
  const contact = useContact();
  const [code, setCode] = useState('');
  const [phone, setPhone] = useState('');
  const [errors, setErrors] = useState<{ code?: string; phone?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LookupResult | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    if (!/^KSR-\d{6}-\d{3,}$/i.test(code.trim())) next.code = 'Enter the booking code, for example KSR-261012-004.';
    const phoneErr = validatePhone(phone);
    if (phoneErr) next.phone = phoneErr;
    setErrors(next);
    setResult(null);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      const { data, error } = await api.rpc('lookup_booking', { p_code: code.trim().toUpperCase(), p_phone: normalizePhone(phone) });
      if (error) throw error;
      setResult(data as LookupResult);
    } catch (err) {
      setErrors({ form: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SitePage>
      <div className="mx-auto max-w-[560px] px-5 py-10 sm:px-6 md:py-16">
        <h1 className="display m-0 text-[48px] md:text-[64px]">Check a booking</h1>
        <p className="m-0 mt-3 text-lg text-ink-2">Enter the code from your confirmation and the mobile number you booked with.</p>
        <form onSubmit={submit} noValidate className="mt-8 flex flex-col gap-5">
          <Field label="Booking code" error={errors.code}>
            <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} autoComplete="off" spellCheck={false} placeholder="KSR-261012-004" />
          </Field>
          <Field label="Mobile number" error={errors.phone}>
            <Input type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
          {errors.form && <Alert>{errors.form}</Alert>}
          <Button type="submit" size="lg" loading={busy} className="self-start">
            Check status
          </Button>
        </form>
        <div aria-live="polite" className="mt-8">
          {result && !result.found && (
            <Alert tone="info">
              We couldn&apos;t find a booking with that code and mobile number.{contact.phoneLabel ? ` Call us on ${contact.phoneLabel}.` : ''}
            </Alert>
          )}
          {result?.found && (
            <div className="flex flex-col gap-3 rounded-[18px] bg-ink p-6 text-night-text">
              <p className="m-0 font-mono text-lg font-semibold">{result.code}</p>
              <p className="display m-0 text-[40px] text-plate">{result.status}</p>
              <dl className="m-0 flex flex-col">
                {(
                  [
                    ['Car', result.car],
                    ['Package', result.package],
                    ['Pickup', result.pickup_at ? formatWhen(result.pickup_at) : ''],
                    ['Return by', result.return_due_at ? formatWhen(result.return_due_at) : ''],
                  ] as const
                ).map(([k, v], i) => (
                  <div key={k} className={i < 3 ? 'flex justify-between gap-3 border-b border-night-line py-2.5' : 'flex justify-between gap-3 py-2.5'}>
                    <dt className="text-night-muted">{k}</dt>
                    <dd className="m-0 text-right font-semibold">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </div>
      </div>
    </SitePage>
  );
}
