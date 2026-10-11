// /admin/bookings/:code/print: rental summary and agreement for print or PDF (BKA-11, P1).
// Pre-filled from the booking; blanks are left for anything not recorded yet so it can be completed by hand.
import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { ArrowLeft, Printer } from 'lucide-react';
import {
  BOOKING_STATUS_LABELS,
  CHARGE_KIND_LABELS,
  FUEL_LABELS,
  FUEL_LEVEL_LABELS,
  FUEL_LEVELS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_TYPE_LABELS,
  REFUND_TYPES,
  SOURCE_LABELS,
  TRANSMISSION_LABELS,
} from '@shared/constants.ts';
import { maskDocNumber } from '@shared/documents.ts';
import { fillTemplate, type BookingRules, type BusinessSettings } from '@shared/settings.ts';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Field';
import { EmptyState } from '@/components/ui/Layout';
import { PageSpinner } from '@/components/ui/Spinner';
import { api } from '@/integrations/api/client';
import { errorMessage, unwrap } from '@/lib/errors';
import { formatDateTime, formatPhone, formatRupees } from '@/lib/format';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { useNow } from '@/lib/useNow';
import type { BookingCharge, BookingWithRefs, Car, HandoverRecord, Payment, PolicyVersion } from '@/types/db';
import { useBookingByCode } from '../../hooks/bookings';
import { qk, useCars, useSetting, useStaffName } from '../../hooks/queries';
import { HIDDEN_CUSTOMER, packageLabel } from './list/bookingFormat';

// A4 page box; the admin shell's padding is dropped so the page margins come from @page.
const PRINT_CSS = '@page { size: A4; margin: 14mm; } @media print { #admin-main { padding: 0 !important; } }';

interface PrintExtras {
  handovers: HandoverRecord[];
  charges: BookingCharge[];
  payments: Payment[];
  customer: { dl_number: string | null; email: string | null } | null;
  terms: Pick<PolicyVersion, 'version' | 'title' | 'body_md' | 'published_at'> | null;
}

function usePrintExtras(code: string, booking: BookingWithRefs | null | undefined) {
  const id = booking?.id;
  const customerId = booking?.customer_id;
  return useQuery({
    queryKey: [...qk.booking(code), 'print', id],
    enabled: Boolean(id),
    queryFn: async (): Promise<PrintExtras> => {
      const [handovers, charges, payments, customer, terms] = await Promise.all([
        api.from('handover_records').select('*').eq('booking_id', id!),
        api.from('booking_charges').select('*').eq('booking_id', id!).order('created_at'),
        api.from('payments').select('*').eq('booking_id', id!).order('received_at'),
        // Null for Staff outside the booking day (row-level security).
        api.from('customers').select('dl_number, email').eq('id', customerId!).maybeSingle(),
        api
          .from('policy_versions')
          .select('version, title, body_md, published_at')
          .eq('kind', 'terms')
          .eq('locale', 'en')
          .order('version', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      return {
        handovers: unwrap(handovers) as HandoverRecord[],
        charges: unwrap(charges) as BookingCharge[],
        payments: unwrap(payments) as Payment[],
        customer: unwrap(customer) as PrintExtras['customer'],
        terms: unwrap(terms) as PrintExtras['terms'],
      };
    },
  });
}

export default function BookingPrintPage() {
  const { code = '' } = useParams();
  useDocumentMeta({ title: `Rental agreement ${code} · KSR admin`, noindex: true });
  const booking = useBookingByCode(code);
  const extras = usePrintExtras(code, booking.data);
  const business = useSetting('business');
  const rules = useSetting('booking_rules');
  const cars = useCars();

  const back = (
    <Link to={`/admin/bookings/${encodeURIComponent(code)}`} className="no-print mb-4 inline-flex min-h-11 items-center gap-1.5 font-semibold">
      <ArrowLeft size={18} aria-hidden="true" /> Back to booking
    </Link>
  );

  if (booking.isPending || (booking.data && extras.isPending) || business.isPending || rules.isPending) {
    return <PageSpinner label="Preparing the agreement" />;
  }
  const failed = booking.error ?? extras.error ?? business.error ?? rules.error;
  if (failed) {
    return (
      <>
        {back}
        <Alert title="Couldn't prepare the agreement">{errorMessage(failed)}</Alert>
      </>
    );
  }
  if (!booking.data || !extras.data || !business.data || !rules.data) {
    return (
      <>
        {back}
        <EmptyState title="Booking not found">Check the booking code, or open it from the bookings list.</EmptyState>
      </>
    );
  }
  return (
    <>
      {back}
      <PrintDocument
        booking={booking.data}
        extras={extras.data}
        business={business.data}
        rules={rules.data}
        car={cars.data?.find((c) => c.id === booking.data!.car_id) ?? null}
      />
    </>
  );
}

// ------------------------------------------------------------------ document

function Section({ title, children, avoidBreak = true }: { title: string; children: ReactNode; avoidBreak?: boolean }) {
  return (
    <section className={avoidBreak ? 'mt-6 break-inside-avoid print:mt-5' : 'mt-6 print:mt-5'}>
      <h2 className="m-0 mb-2 border-b-2 border-ink pb-1 text-[13px] font-bold tracking-wide uppercase">{title}</h2>
      {children}
    </section>
  );
}

function Pairs({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="m-0 grid grid-cols-1 gap-x-8 gap-y-1.5 sm:grid-cols-2 print:grid-cols-2">
      {items.map(([k, v]) => (
        <div key={k} className="flex min-w-0 gap-2">
          <dt className="w-36 shrink-0 text-ink-3">{k}</dt>
          <dd className="m-0 min-w-0 font-semibold break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const KM = new Intl.NumberFormat('en-IN');

/** A line to fill in by hand. */
const Blank = ({ width = 'w-32' }: { width?: string }) => (
  <span className={`inline-block border-b border-ink align-bottom ${width}`}>
    <span className="sr-only">Blank</span>&nbsp;
  </span>
);

const cellClass = 'border-b border-line px-2 py-1.5 text-left align-top';
const headClass = 'border-b-2 border-ink px-2 py-1.5 text-left text-[12px] font-bold uppercase';

function termsHtml(md: string, values: Record<string, string>): string {
  // Fill {placeholders} from Settings; anything still unset becomes a blank to complete by hand.
  const filled = fillTemplate(md, values).replace(/\{(\w+)\}/g, '________');
  return DOMPurify.sanitize(marked.parse(filled, { async: false }) as string);
}

function PrintDocument({
  booking: b,
  extras,
  business,
  rules,
  car,
}: {
  booking: BookingWithRefs;
  extras: PrintExtras;
  business: BusinessSettings;
  rules: BookingRules;
  car: Car | null;
}) {
  const now = useNow();
  const staffName = useStaffName();
  const [busy, setBusy] = useState(false);

  const pickup = extras.handovers.find((h) => h.kind === 'pickup') ?? null;
  const ret = extras.handovers.find((h) => h.kind === 'return') ?? null;
  const kmDriven = pickup && ret ? ret.odometer_km - pickup.odometer_km : null;
  const balance = b.total_paise - b.paid_paise;
  const depositHeld = b.deposit_received_paise - b.deposit_refunded_paise;
  const kmLimit = b.package === '12h' ? rules.km_limit_12h : b.package === '24h' ? rules.km_limit_24h : null;
  const dlMasked = maskDocNumber(extras.customer?.dl_number);

  const terms = extras.terms
    ? termsHtml(extras.terms.body_md, {
        name: business.name,
        phone: formatPhone(business.phone),
        email: business.email,
        address: business.address,
        fuel_policy: rules.fuel_policy,
      })
    : null;

  async function print() {
    setBusy(true);
    // BKA-11: printing is logged (AUD-01). Never let logging stop the print.
    const log = api
      .rpc('log_client_event', {
        p_action: 'booking.print',
        p_entity_type: 'bookings',
        p_entity_id: b.id,
        p_meta: { booking_code: b.booking_code },
      })
      .then(({ error }) => {
        if (error) console.warn('Could not log the print:', error.message);
      });
    await Promise.race([log, new Promise((resolve) => window.setTimeout(resolve, 3000))]);
    setBusy(false);
    window.print();
  }

  const fuelOf = (h: HandoverRecord | null) =>
    h ? (
      FUEL_LEVEL_LABELS[h.fuel_level]
    ) : (
      <span className="inline-flex flex-wrap gap-x-3 font-normal">
        {FUEL_LEVELS.map((f) => (
          <span key={f}>☐ {FUEL_LEVEL_LABELS[f]}</span>
        ))}
      </span>
    );

  return (
    <>
      <style>{PRINT_CSS}</style>
      <div className="no-print mb-5 flex flex-wrap items-center gap-3">
        <Button onClick={() => void print()} loading={busy} loadingText="Preparing…" icon={<Printer size={18} aria-hidden="true" />}>
          Print / Save as PDF
        </Button>
        <p className="m-0 text-[15px] text-muted">To save a PDF, choose “Save as PDF” as the printer.</p>
      </div>

      <article className="mx-auto max-w-[210mm] rounded-2xl border border-line-card bg-white p-6 text-[14px] leading-snug text-ink sm:p-10 print:max-w-none print:rounded-none print:border-0 print:p-0 print:text-[10.5pt]">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-ink pb-4">
          <div className="min-w-0">
            <p className="m-0 text-[22px] font-extrabold">{business.name}</p>
            {business.address && <p className="m-0 whitespace-pre-line">{business.address}</p>}
            <p className="m-0">
              {[business.phone && `Phone ${formatPhone(business.phone)}`, business.email].filter(Boolean).join(' · ')}
            </p>
          </div>
          <div className="text-right">
            <h1 className="m-0 text-[18px] font-extrabold">Rental agreement and booking summary</h1>
            <p className="m-0 font-mono text-[16px] font-bold">{b.booking_code}</p>
            <p className="m-0 text-ink-3">
              Status: {BOOKING_STATUS_LABELS[b.status]} · Printed {formatDateTime(now)}
            </p>
          </div>
        </header>

        <Section title="Customer">
          <Pairs
            items={[
              ['Name', b.customer?.full_name ?? HIDDEN_CUSTOMER],
              ['Mobile', b.customer?.phone ? formatPhone(b.customer.phone) : HIDDEN_CUSTOMER],
              ['Driving licence', dlMasked ?? <Blank />],
              ['Email', extras.customer?.email || '—'],
            ]}
          />
        </Section>

        <Section title="Car and rental">
          <Pairs
            items={[
              ['Car', b.car?.display_name ?? '—'],
              ['Registration', b.car?.registration_number ?? <Blank />],
              ['Fuel / gearbox', car ? `${FUEL_LABELS[car.fuel]}, ${TRANSMISSION_LABELS[car.transmission]}` : '—'],
              ['Package', packageLabel(b)],
              ['Pickup', formatDateTime(b.pickup_at)],
              ['Return by', formatDateTime(b.return_due_at)],
              ...(b.actual_pickup_at ? ([['Picked up', formatDateTime(b.actual_pickup_at)]] as Array<[string, ReactNode]>) : []),
              ...(b.actual_return_at ? ([['Returned', formatDateTime(b.actual_return_at)]] as Array<[string, ReactNode]>) : []),
              ['Booked via', SOURCE_LABELS[b.source]],
            ]}
          />
        </Section>

        <Section title="Charges">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th scope="col" className={headClass}>
                  Item
                </th>
                <th scope="col" className={`${headClass} text-right`}>
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className={cellClass}>Rent ({packageLabel(b)})</td>
                <td className={`${cellClass} text-right`}>{formatRupees(b.price_quoted_paise)}</td>
              </tr>
              {b.discount_paise > 0 && (
                <tr>
                  <td className={cellClass}>Discount</td>
                  <td className={`${cellClass} text-right`}>{formatRupees(-b.discount_paise)}</td>
                </tr>
              )}
              {extras.charges.map((c) => (
                <tr key={c.id}>
                  <td className={cellClass}>
                    {CHARGE_KIND_LABELS[c.kind]}
                    {c.note ? `: ${c.note}` : ''}
                  </td>
                  <td className={`${cellClass} text-right`}>{formatRupees(c.amount_paise)}</td>
                </tr>
              ))}
              <tr className="font-bold">
                <td className={cellClass}>Total</td>
                <td className={`${cellClass} text-right`}>{formatRupees(b.total_paise)}</td>
              </tr>
              <tr>
                <td className={cellClass}>Paid (rent and extras, less refunds)</td>
                <td className={`${cellClass} text-right`}>{formatRupees(b.paid_paise)}</td>
              </tr>
              <tr className="font-bold">
                <td className={cellClass}>Balance to pay</td>
                <td className={`${cellClass} text-right`}>{formatRupees(Math.max(0, balance))}</td>
              </tr>
            </tbody>
          </table>
          <p className="m-0 mt-2">
            Security deposit: <strong>{formatRupees(b.deposit_paise)}</strong>
            {b.deposit_received_paise > 0 && <> · received {formatRupees(b.deposit_received_paise)}</>}
            {b.deposit_refunded_paise > 0 && <> · refunded {formatRupees(b.deposit_refunded_paise)}</>}
            {b.deposit_received_paise > 0 && <> · held {formatRupees(depositHeld)}</>}
          </p>
        </Section>

        <Section title="Payments">
          {extras.payments.length === 0 ? (
            <p className="m-0 text-ink-3">No payments recorded yet.</p>
          ) : (
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th scope="col" className={headClass}>
                    Date
                  </th>
                  <th scope="col" className={headClass}>
                    Type
                  </th>
                  <th scope="col" className={headClass}>
                    Method
                  </th>
                  <th scope="col" className={headClass}>
                    Reference
                  </th>
                  <th scope="col" className={`${headClass} text-right`}>
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {extras.payments.map((p) => (
                  <tr key={p.id}>
                    <td className={cellClass}>{formatDateTime(p.received_at)}</td>
                    <td className={cellClass}>{PAYMENT_TYPE_LABELS[p.type]}</td>
                    <td className={cellClass}>{PAYMENT_METHOD_LABELS[p.method]}</td>
                    <td className={cellClass}>{p.reference || '—'}</td>
                    <td className={`${cellClass} text-right`}>
                      {formatRupees(REFUND_TYPES.includes(p.type) ? -p.amount_paise : p.amount_paise)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section title="Rental rules">
          <Pairs
            items={[
              ['Fuel', rules.fuel_policy],
              [
                'Distance',
                b.package === 'custom'
                  ? 'As agreed'
                  : kmLimit
                    ? `${kmLimit} km included${rules.extra_km_rate_paise ? `, then ${formatRupees(rules.extra_km_rate_paise)} per km` : ''}`
                    : 'No km limit',
              ],
              [
                'Late return',
                `${rules.late_grace_minutes} min grace, then ${formatRupees(rules.late_fee_per_hour_paise)} per hour or part of an hour`,
              ],
              ['Deposit', `${formatRupees(b.deposit_paise)}, refunded after the car is returned and checked`],
            ]}
          />
        </Section>

        <Section title="Handover and return">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th scope="col" className={headClass}>
                  {' '}
                </th>
                <th scope="col" className={headClass}>
                  Date and time
                </th>
                <th scope="col" className={headClass}>
                  Odometer
                </th>
                <th scope="col" className={headClass}>
                  Fuel
                </th>
                <th scope="col" className={headClass}>
                  Staff
                </th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ['Pickup', pickup],
                  ['Return', ret],
                ] as const
              ).map(([label, h]) => (
                <tr key={label}>
                  <th scope="row" className={`${cellClass} font-bold`}>
                    {label}
                  </th>
                  <td className={cellClass}>{h ? formatDateTime(h.recorded_at) : <Blank />}</td>
                  <td className={cellClass}>{h ? `${KM.format(h.odometer_km)} km` : <Blank width="w-20" />}</td>
                  <td className={cellClass}>{fuelOf(h)}</td>
                  <td className={cellClass}>{h ? staffName(h.recorded_by) : <Blank width="w-24" />}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {kmDriven !== null && <p className="m-0 mt-2">Distance driven: {KM.format(kmDriven)} km</p>}
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 print:grid-cols-2">
            <div>
              <p className="m-0 font-semibold">Existing damage at pickup</p>
              {pickup?.damage_notes ? (
                <p className="m-0 whitespace-pre-line">{pickup.damage_notes}</p>
              ) : (
                <div className="mt-1 h-14 border-b border-ink" />
              )}
            </div>
            <div>
              <p className="m-0 font-semibold">Damage noted at return</p>
              {ret?.damage_notes ? (
                <p className="m-0 whitespace-pre-line">{ret.damage_notes}</p>
              ) : (
                <div className="mt-1 h-14 border-b border-ink" />
              )}
            </div>
          </div>
        </Section>

        {terms && extras.terms && (
          <Section title={`${extras.terms.title} (version ${extras.terms.version})`} avoidBreak={false}>
            <div
              className="text-[13px] print:text-[9.5pt] [&_h1]:mt-3 [&_h1]:mb-1 [&_h1]:text-[14px] [&_h1]:font-bold [&_h2]:mt-3 [&_h2]:mb-1 [&_h2]:text-[13px] [&_h2]:font-bold [&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:font-bold [&_li]:my-0.5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1.5 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5"
              // Owner-authored policy text, sanitised with DOMPurify.
              dangerouslySetInnerHTML={{ __html: terms }}
            />
          </Section>
        )}

        <Section title="Signatures">
          <p className="m-0">
            I have read and accept the terms above, and the condition of the car, odometer and fuel as recorded at pickup.
          </p>
          <div className="mt-10 grid grid-cols-1 gap-10 sm:grid-cols-2 print:grid-cols-2">
            {[
              { who: 'Customer', name: b.customer?.full_name ?? '' },
              { who: `For ${business.name}`, name: '' },
            ].map((s) => (
              <div key={s.who}>
                <div className="h-12 border-b border-ink" />
                <p className="m-0 mt-1 font-semibold">{s.who}</p>
                <p className="m-0 mt-3">
                  Name: {s.name || <Blank width="w-48" />}
                </p>
                <p className="m-0 mt-3">
                  Date: <Blank width="w-40" />
                </p>
              </div>
            ))}
          </div>
        </Section>
      </article>
    </>
  );
}
