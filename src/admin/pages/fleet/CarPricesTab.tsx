// Prices tab: 12 hr and 24 hr prices with history (FLT-03). History rows come from the
// cars_price_history trigger; bookings keep the price stored when they were made (8.3).
import { useState, type FormEvent } from 'react';
import { Save } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { PricePlate } from '@/components/brand/Brand';
import { Badge } from '@/components/ui/Badges';
import { Button } from '@/components/ui/Button';
import { Alert, Field, Input } from '@/components/ui/Field';
import { Card, CardBody, CardHeader, EmptyState } from '@/components/ui/Layout';
import { Spinner } from '@/components/ui/Spinner';
import { api } from '@/integrations/api/client';
import { errorMessage, unwrap } from '@/lib/errors';
import { formatDateTime, formatRupees, paiseToInput, parseRupees } from '@/lib/format';
import type { Car } from '@/types/db';
import { qk, useStaffName } from '../../hooks/queries';
import { usePriceHistory } from './fleetData';

export function CarPricesTab({ car }: { car: Car }) {
  return (
    <div className="flex flex-col gap-5">
      <PriceForm key={`${car.id}-${car.price_12h_paise}-${car.price_24h_paise}`} car={car} />
      <PriceHistory carId={car.id} />
    </div>
  );
}

function PriceForm({ car }: { car: Car }) {
  const queryClient = useQueryClient();
  const [p12, setP12] = useState(paiseToInput(car.price_12h_paise));
  const [p24, setP24] = useState(paiseToInput(car.price_24h_paise));
  const [errors, setErrors] = useState<{ p12?: string; p24?: string; form?: string }>({});
  const [saving, setSaving] = useState(false);

  const v12 = parseRupees(p12);
  const v24 = parseRupees(p24);
  const unchanged = v12 === car.price_12h_paise && v24 === car.price_24h_paise;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    if (!v12 || v12 <= 0) next.p12 = 'Enter the 12 hr price in rupees, for example 1300.';
    if (!v24 || v24 <= 0) next.p24 = 'Enter the 24 hr price in rupees, for example 2200.';
    setErrors(next);
    if (next.p12 || next.p24) {
      document.getElementById(next.p12 ? 'price-12' : 'price-24')?.focus();
      return;
    }
    setSaving(true);
    try {
      unwrap(await api.from('cars').update({ price_12h_paise: v12, price_24h_paise: v24 }).eq('id', car.id).select('id').single());
      await queryClient.invalidateQueries({ queryKey: qk.cars });
      toast.success('Prices saved');
    } catch (err) {
      setErrors({ form: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader title="Current prices" description="Price changes apply to new bookings only; existing bookings keep their price." />
      <CardBody>
        <form onSubmit={submit} noValidate className="flex flex-col gap-5">
          <div className="flex flex-wrap gap-6">
            <span className="flex flex-col gap-1">
              <span className="text-sm text-muted">12 hrs</span>
              <PricePlate size="sm">{formatRupees(car.price_12h_paise)}</PricePlate>
            </span>
            <span className="flex flex-col gap-1">
              <span className="text-sm text-muted">24 hrs</span>
              <PricePlate size="sm">{formatRupees(car.price_24h_paise)}</PricePlate>
            </span>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="12 hr price (₹)" required error={errors.p12}>
              <Input id="price-12" inputMode="decimal" value={p12} onChange={(e) => setP12(e.target.value)} autoComplete="off" />
            </Field>
            <Field label="24 hr price (₹)" required error={errors.p24}>
              <Input id="price-24" inputMode="decimal" value={p24} onChange={(e) => setP24(e.target.value)} autoComplete="off" />
            </Field>
          </div>
          {v12 && v24 && v24 < v12 ? (
            <Alert tone="warning">The 24 hr price is lower than the 12 hr price. Check this is right before saving.</Alert>
          ) : null}
          {errors.form && <Alert title="Couldn't save the prices">{errors.form}</Alert>}
          <div className="flex justify-end">
            <Button type="submit" loading={saving} loadingText="Saving…" disabled={unchanged} icon={<Save size={18} aria-hidden="true" />}>
              Save prices
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

function PriceHistory({ carId }: { carId: string }) {
  const history = usePriceHistory(carId);
  const staffName = useStaffName();
  return (
    <Card>
      <CardHeader title="Price history" />
      {history.isLoading ? (
        <div className="flex justify-center p-6">
          <Spinner label="Loading price history" />
        </div>
      ) : history.error ? (
        <p className="m-0 p-5 text-danger">{errorMessage(history.error)}</p>
      ) : !history.data?.length ? (
        <CardBody>
          <EmptyState title="No price changes yet" />
        </CardBody>
      ) : (
        <ol className="m-0 list-none p-0">
          {history.data.map((h, i) => (
            <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line-card px-4 py-3 last:border-0 sm:px-5">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">
                  {formatRupees(h.price_12h_paise)} for 12 hrs · {formatRupees(h.price_24h_paise)} for 24 hrs
                </span>
                {i === 0 && <Badge tone="green">Current</Badge>}
              </span>
              <span className="text-sm text-muted">
                {staffName(h.changed_by)}, {formatDateTime(h.changed_at)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
