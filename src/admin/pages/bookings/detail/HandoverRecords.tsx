// HND-01..03: what was recorded at pickup and return.
import { Check, X } from 'lucide-react';
import { FUEL_LEVEL_LABELS } from '@shared/constants.ts';
import { Card, CardHeader } from '@/components/ui/Layout';
import { formatDateTime, formatRupees } from '@/lib/format';
import type { HandoverChecklist, HandoverRecord } from '@/types/db';
import { useStaffName } from '@/admin/hooks/queries';
import { ACCESSORIES, FUEL_SPOKEN, PHOTO_SLOTS } from './helpers';

export function HandoverRecordsCard({ records }: { records: HandoverRecord[] }) {
  const staffName = useStaffName();
  if (records.length === 0) return null;
  const pickup = records.find((r) => r.kind === 'pickup');
  return (
    <Card>
      <CardHeader title="Handover and return" description="Photos and the signature are under Booking documents." />
      <div className="grid gap-0 md:grid-cols-2">
        {records.map((r) => {
          const c: HandoverChecklist = r.checklist ?? {};
          const photos = PHOTO_SLOTS.filter((s) => c.photos?.[s.key]).length;
          const km = r.kind === 'return' && pickup ? r.odometer_km - pickup.odometer_km : null;
          return (
            <section key={r.id} className="flex flex-col gap-3 border-b border-line-card px-4 py-4 last:border-b-0 sm:px-5 md:border-r md:border-b-0 md:last:border-r-0">
              <h3 className="m-0 text-base font-bold">{r.kind === 'pickup' ? 'Pickup' : 'Return'}</h3>
              <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-2 text-[15px]">
                <div>
                  <dt className="text-sm text-muted">Odometer</dt>
                  <dd className="m-0 font-semibold">
                    {r.odometer_km.toLocaleString('en-IN')} km{km !== null ? ` (+${km.toLocaleString('en-IN')})` : ''}
                  </dd>
                </div>
                <div>
                  <dt className="text-sm text-muted">Fuel</dt>
                  <dd className="m-0 font-semibold">
                    <span aria-hidden="true">{FUEL_LEVEL_LABELS[r.fuel_level]}</span>
                    <span className="sr-only">{FUEL_SPOKEN[r.fuel_level]}</span>
                  </dd>
                </div>
                <div>
                  <dt className="text-sm text-muted">Photos</dt>
                  <dd className="m-0 font-semibold">
                    {photos} of {PHOTO_SLOTS.length} views
                  </dd>
                </div>
                <div>
                  <dt className="text-sm text-muted">Signature</dt>
                  <dd className="m-0 font-semibold">{r.signature_document_id ? 'Saved' : 'None'}</dd>
                </div>
                {typeof c.deposit_collected_paise === 'number' && c.deposit_collected_paise > 0 && (
                  <div>
                    <dt className="text-sm text-muted">Deposit collected</dt>
                    <dd className="m-0 font-semibold">{formatRupees(c.deposit_collected_paise)}</dd>
                  </div>
                )}
                {r.kind === 'pickup' && (
                  <div>
                    <dt className="text-sm text-muted">Terms accepted</dt>
                    <dd className="m-0 font-semibold">{c.terms_accepted ? 'Yes' : 'No'}</dd>
                  </div>
                )}
              </dl>
              {c.accessories && (
                <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[15px]">
                  {ACCESSORIES.map((a) => {
                    const ok = Boolean(c.accessories?.[a.key]);
                    return (
                      <li key={a.key} className="flex items-center gap-2">
                        {ok ? <Check size={16} className="text-emerald-700" aria-hidden="true" /> : <X size={16} className="text-danger" aria-hidden="true" />}
                        <span>
                          {a.label}
                          <span className="sr-only">{ok ? ': present' : ': missing'}</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {r.damage_notes && (
                <p className="m-0 text-[15px]">
                  <span className="font-semibold">{r.kind === 'pickup' ? 'Existing damage: ' : 'New damage: '}</span>
                  {r.damage_notes}
                </p>
              )}
              <p className="m-0 text-sm text-muted">
                {staffName(r.recorded_by)}, {formatDateTime(r.recorded_at)}
              </p>
            </section>
          );
        })}
      </div>
    </Card>
  );
}
