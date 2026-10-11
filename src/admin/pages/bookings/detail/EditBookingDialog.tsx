// BKA-05: change car, package, pickup time or price before pickup. Price overrides and
// discounts need a reason; clashes show live while the car or time changes.
import { useState } from 'react';
import { Link } from 'react-router';
import toast from 'react-hot-toast';
import { computeReturn } from '@shared/booking.ts';
import { PACKAGE_LABELS, PACKAGES, type BookingPackage } from '@shared/constants.ts';
import { fromIstLocalInput, toIstLocalInput } from '@shared/time.ts';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogFooter } from '@/components/ui/Dialog';
import { Alert, Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Spinner';
import { errorMessage, toAppError } from '@/lib/errors';
import { formatIsoDate, formatRupees, formatWhen, paiseToInput, parseRupees } from '@/lib/format';
import type { BookingWithRefs, Car } from '@/types/db';
import { useCars } from '@/admin/hooks/queries';
import { rpc, useCarClashes, useCarPaperProblems, useRefresh } from './api';
import { MoneyInput } from './ui';

const stdPrice = (car: Car | undefined, pkg: BookingPackage) =>
  !car ? null : pkg === '12h' ? car.price_12h_paise : pkg === '24h' ? car.price_24h_paise : null;

export function EditBookingDialog({ open, onClose, booking }: { open: boolean; onClose: () => void; booking: BookingWithRefs }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onClose={onClose} locked={busy} size="lg" title={`Edit ${booking.booking_code}`} description="Changes are logged on the timeline.">
      <EditForm booking={booking} onClose={onClose} busy={busy} setBusy={setBusy} />
    </Dialog>
  );
}

function EditForm({ booking, onClose, busy, setBusy }: { booking: BookingWithRefs; onClose: () => void; busy: boolean; setBusy: (b: boolean) => void }) {
  const refresh = useRefresh();
  const cars = useCars();
  const allCars = cars.data ?? [];
  const [carId, setCarId] = useState(booking.car_id);
  const [pkg, setPkg] = useState<BookingPackage>(booking.package);
  const [customHours, setCustomHours] = useState(String(booking.custom_hours ?? (booking.package === '12h' ? 12 : 24)));
  const [pickup, setPickup] = useState(toIstLocalInput(booking.pickup_at));
  const [price, setPrice] = useState(paiseToInput(booking.price_quoted_paise));
  const [priceTouched, setPriceTouched] = useState(false);
  const [discount, setDiscount] = useState(paiseToInput(booking.discount_paise));
  const [deposit, setDeposit] = useState(paiseToInput(booking.deposit_paise));
  const [notes, setNotes] = useState(booking.admin_notes);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const car = allCars.find((c) => c.id === carId);
  const std = stdPrice(car, pkg);
  const hours = pkg === 'custom' ? Number(customHours) : null;
  const hoursOk = pkg !== 'custom' || (Number.isInteger(hours) && (hours ?? 0) >= 1 && (hours ?? 0) <= 720);
  const pickupDate = fromIstLocalInput(pickup);
  const returnDate = pickupDate && hoursOk ? computeReturn(pickupDate, pkg, hours) : null;
  const clashes = useCarClashes(carId, pickupDate, returnDate, booking.id);
  const papers = useCarPaperProblems(carId, returnDate, true);

  const carChanged = carId !== booking.car_id;
  const pkgChanged = pkg !== booking.package;
  const pricePaise = parseRupees(price);
  const discountPaise = discount.trim() ? parseRupees(discount) : 0;
  const sendPrice = pricePaise !== null && (pricePaise !== booking.price_quoted_paise || ((carChanged || pkgChanged) && std !== null));
  const priceNeedsReason = sendPrice && pricePaise !== std;
  const discountChanged = discountPaise !== booking.discount_paise;
  const needsReason = priceNeedsReason || discountChanged;

  function suggestPrice(nextCar: Car | undefined, nextPkg: BookingPackage) {
    if (priceTouched) return;
    const s = stdPrice(nextCar, nextPkg);
    setPrice(paiseToInput(s ?? booking.price_quoted_paise));
  }

  async function save() {
    const e: Record<string, string> = {};
    if (!car) e.car = 'Choose a car.';
    if (!pickupDate) e.pickup = 'Enter the pickup date and time.';
    if (!hoursOk) e.hours = 'Enter whole hours between 1 and 720.';
    if (pricePaise === null) e.price = 'Enter the price in rupees, for example 1800.';
    if (discountPaise === null) e.discount = 'Enter the discount in rupees, or 0.';
    else if (pricePaise !== null && discountPaise > pricePaise + booking.extra_charges_paise) e.discount = "The discount can't be more than the total.";
    const depositPaise = deposit.trim() ? parseRupees(deposit) : 0;
    if (depositPaise === null) e.deposit = 'Enter the deposit in rupees, or 0.';
    if (needsReason && !reason.trim()) e.reason = priceNeedsReason ? 'A price override needs a reason.' : 'A discount needs a reason.';
    setErrors(e);
    if (Object.keys(e).length) return;

    const args: Record<string, unknown> = { p_booking: booking.id, p_reason: reason.trim() || null };
    if (carChanged) args.p_car_id = carId;
    if (pkgChanged) args.p_package = pkg;
    if (pkg === 'custom') args.p_custom_hours = hours;
    if (pickup !== toIstLocalInput(booking.pickup_at)) args.p_pickup_at = pickupDate!.toISOString();
    if (sendPrice) args.p_price_paise = pricePaise;
    if (discountChanged) args.p_discount_paise = discountPaise;
    if (depositPaise !== booking.deposit_paise) args.p_deposit_paise = depositPaise;
    if (notes !== booking.admin_notes) args.p_admin_notes = notes;

    setBusy(true);
    try {
      const res = await rpc<{ changed: boolean }>('update_booking', args);
      toast.success(res?.changed ? 'Booking updated' : 'Nothing to change');
      await refresh();
      onClose();
    } catch (err) {
      const ae = toAppError(err);
      setErrors(ae.code === 'price_reason' ? { reason: ae.message } : { submit: ae.message });
    } finally {
      setBusy(false);
    }
  }

  const clashList = clashes.data ?? [];
  const paperList = papers.data ?? [];

  return (
    <>
      <div className="flex flex-col gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Car" error={errors.car}>
            <Select
              value={carId}
              onChange={(e) => {
                setCarId(e.target.value);
                suggestPrice(
                  allCars.find((c) => c.id === e.target.value),
                  pkg,
                );
              }}
            >
              {cars.isLoading && <option value={carId}>{booking.car?.display_name ?? 'Loading…'}</option>}
              {allCars
                .filter((c) => c.status === 'active' || c.id === booking.car_id)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.display_name}
                    {c.registration_number ? ` (${c.registration_number})` : ''}
                    {c.status !== 'active' ? ' – inactive' : ''}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Package">
            <Select
              value={pkg}
              onChange={(e) => {
                const next = e.target.value as BookingPackage;
                setPkg(next);
                suggestPrice(car, next);
              }}
            >
              {PACKAGES.map((p) => (
                <option key={p} value={p}>
                  {p === 'custom' ? 'Custom hours' : PACKAGE_LABELS[p]}
                  {car && p !== 'custom' ? ` – ${formatRupees(stdPrice(car, p))}` : ''}
                </option>
              ))}
            </Select>
          </Field>
          {pkg === 'custom' && (
            <Field label="Hours" error={errors.hours}>
              <Input inputMode="numeric" value={customHours} onChange={(e) => setCustomHours(e.target.value.replace(/\D/g, ''))} />
            </Field>
          )}
          <Field label="Pickup (IST)" error={errors.pickup} hint={returnDate ? `Return by ${formatWhen(returnDate)}.` : undefined}>
            <Input type="datetime-local" value={pickup} onChange={(e) => setPickup(e.target.value)} />
          </Field>
        </div>

        <div aria-live="polite" className="flex flex-col gap-2">
          {clashes.isFetching && !clashes.data ? (
            <p className="m-0 flex items-center gap-2 text-sm text-muted">
              <Spinner size={16} /> Checking availability…
            </p>
          ) : clashes.error ? (
            <Alert tone="warning">Couldn&apos;t check availability: {errorMessage(clashes.error)}</Alert>
          ) : clashList.length > 0 ? (
            <Alert tone={booking.status === 'confirmed' ? 'error' : 'warning'} title="This car is not free for the whole time">
              <ul className="m-0 pl-5">
                {clashList.map((c) => (
                  <li key={c.ref_id}>
                    {c.kind === 'booking' ? (
                      <>
                        Booked:{' '}
                        <Link to={`/admin/bookings/${c.booking_code}`} className="font-semibold">
                          {c.booking_code}
                        </Link>
                      </>
                    ) : (
                      <>Maintenance{c.note ? ` (${c.note})` : ''}</>
                    )}
                    , {formatWhen(c.starts_at)} – {formatWhen(c.ends_at)}
                  </li>
                ))}
              </ul>
              {booking.status === 'confirmed' && <p className="m-0 mt-1">Saving will be refused. Choose another car or time.</p>}
            </Alert>
          ) : clashes.data ? (
            <p className="m-0 text-sm font-semibold text-emerald-800">The car is free for this time (including the turnaround buffer).</p>
          ) : null}
          {paperList.length > 0 && (
            <Alert tone="warning" title="Vehicle papers">
              <ul className="m-0 pl-5">
                {paperList.map((p) => (
                  <li key={p.doc_type}>
                    {p.label}: {p.problem === 'missing' ? 'not uploaded' : `expires ${p.expiry_date ? formatIsoDate(p.expiry_date) : ''}, before the return time`}
                  </li>
                ))}
              </ul>
            </Alert>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Price"
            error={errors.price}
            hint={std !== null ? `Standard price ${formatRupees(std)}.` : 'Custom package: set the price.'}
          >
            <MoneyInput
              value={price}
              onChange={(e) => {
                setPrice(e.target.value);
                setPriceTouched(true);
              }}
            />
          </Field>
          <Field label="Discount" error={errors.discount}>
            <MoneyInput value={discount} onChange={(e) => setDiscount(e.target.value)} />
          </Field>
          <Field label="Security deposit" error={errors.deposit}>
            <MoneyInput value={deposit} onChange={(e) => setDeposit(e.target.value)} />
          </Field>
        </div>
        {needsReason && (
          <Field label="Reason for the price or discount" required error={errors.reason} hint="Shown on the timeline and in the audit log.">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        )}
        <Field label="Admin notes" optional hint="Only staff see these.">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
        </Field>
        {errors.submit && <Alert>{errors.submit}</Alert>}
      </div>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={save} loading={busy} loadingText="Saving…">
          Save changes
        </Button>
      </DialogFooter>
    </>
  );
}
