// HND-01/02: pickup checklist on the phone. Full-screen on phones; photos upload as they are
// taken; the customer signs on screen; the deposit is recorded once the handover succeeds.
import { useState } from 'react';
import { CheckCircle2, KeyRound } from 'lucide-react';
import toast from 'react-hot-toast';
import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS, type FuelLevel, type PaymentMethod } from '@shared/constants.ts';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogFooter } from '@/components/ui/Dialog';
import { Alert, Checkbox, Field, Input, Textarea } from '@/components/ui/Field';
import { uploadDocument } from '@/lib/documents';
import { errorMessage, toAppError } from '@/lib/errors';
import { formatRupees, paiseToInput, parseRupees } from '@/lib/format';
import type { BookingWithRefs, HandoverChecklist } from '@/types/db';
import { rpc, useRefresh } from './api';
import { ACCESSORIES, PHOTO_SLOTS, gateFixFor, ledgerOf, parseKm, type AccessoryKey } from './helpers';
import { PhotoSlots } from './PhotoSlots';
import { usePhotoUploads } from './usePhotoUploads';
import { SignaturePad } from './SignaturePad';
import { ChoiceChips, FuelPicker, MoneyInput, StepHeading } from './ui';

const METHOD_OPTIONS = PAYMENT_METHODS.map((m) => ({ value: m, label: PAYMENT_METHOD_LABELS[m] }));

interface Props {
  open: boolean;
  onClose: () => void;
  booking: BookingWithRefs;
  /** Pickup-gate problems at the time the flow started (empty when all checks passed). */
  gateProblems: string[];
  /** Owner override reason when the gate has problems (DOC-09). */
  overrideReason: string | null;
}

export function PickupHandoverDialog(props: Props) {
  const [busy, setBusy] = useState(false);
  const { booking } = props;
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      locked={busy}
      size="lg"
      title="Hand over the car"
      description={`${booking.car?.display_name ?? 'Car'} · ${booking.booking_code}${booking.customer ? ` · ${booking.customer.full_name}` : ''}`}
    >
      <PickupForm {...props} busy={busy} setBusy={setBusy} />
    </Dialog>
  );
}

function PickupForm({ booking, gateProblems, overrideReason, onClose, busy, setBusy }: Props & { busy: boolean; setBusy: (b: boolean) => void }) {
  const refresh = useRefresh();
  const photos = usePhotoUploads(booking.id, 'pickup_photos');
  const ledger = ledgerOf(booking);
  const depositDue = Math.max(0, booking.deposit_paise - ledger.depositHeld);

  const [odometer, setOdometer] = useState('');
  const [fuel, setFuel] = useState<FuelLevel | ''>('');
  const [damage, setDamage] = useState('');
  const [accessories, setAccessories] = useState<Record<AccessoryKey, boolean>>({ spare_wheel: false, jack: false, documents_in_car: false });
  const [deposit, setDeposit] = useState(depositDue > 0 ? paiseToInput(depositDue) : '');
  const [depositMethod, setDepositMethod] = useState<PaymentMethod>('cash');
  const [depositRef, setDepositRef] = useState('');
  const [signature, setSignature] = useState<Blob | null>(null);
  const [signatureDocId, setSignatureDocId] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const identityOk = !gateProblems.some((p) => gateFixFor(p) === 'identity');
  const licenceOk = !gateProblems.some((p) => gateFixFor(p) !== 'identity');
  const missingPhotos = PHOTO_SLOTS.filter((s) => !photos.has(s.key));

  function changeSignature(png: Blob | null) {
    setSignature(png);
    setSignatureDocId(null);
  }

  async function submit() {
    const e: Record<string, string> = {};
    const km = parseKm(odometer);
    if (km === null) e.odometer = 'Enter the odometer reading in whole km, for example 45210.';
    if (!fuel) e.fuel = 'Choose the fuel level.';
    const depositPaise = deposit.trim() ? parseRupees(deposit) : 0;
    if (depositPaise === null) e.deposit = 'Enter the deposit in rupees, for example 2000, or leave it blank.';
    if (photos.busy) e.photos = 'Wait for the photos to finish uploading.';
    if (!signature) e.signature = 'Ask the customer to sign in the box.';
    if (!accepted) e.accepted = "Tick this once the customer has accepted the car's condition and the terms.";
    setErrors(e);
    setFormError(null);
    if (Object.keys(e).length) {
      setFormError(`Check ${Object.keys(e).length === 1 ? 'the highlighted field' : `the ${Object.keys(e).length} highlighted fields`} above.`);
      return;
    }

    setBusy(true);
    try {
      let sigId = signatureDocId;
      if (!sigId && signature) {
        const res = await uploadDocument({
          ownerType: 'booking',
          ownerId: booking.id,
          docType: 'signature',
          file: new File([signature], 'signature.png', { type: 'image/png' }),
          prepared: true,
          notes: 'Customer signature at pickup',
        });
        sigId = res.document.id;
        setSignatureDocId(sigId);
      }
      const checklist: HandoverChecklist = {
        licence_checked: licenceOk,
        identity_checked: identityOk,
        photos: Object.fromEntries(PHOTO_SLOTS.map((s) => [s.key, photos.has(s.key)])),
        photo_count: photos.total,
        accessories,
        deposit_collected_paise: depositPaise ?? 0,
        deposit_method: depositPaise ? depositMethod : null,
        terms_accepted: accepted,
        gate_override: overrideReason ? { problems: gateProblems, reason: overrideReason } : null,
      };
      await rpc('record_handover', {
        p_booking: booking.id,
        p_kind: 'pickup',
        p_odometer_km: km,
        p_fuel_level: fuel,
        p_checklist: checklist,
        p_damage_notes: damage.trim(),
        p_signature_document_id: sigId,
        p_override_reason: overrideReason,
      });

      let depositError: string | null = null;
      if (depositPaise) {
        try {
          await rpc('record_payment', {
            p_booking: booking.id,
            p_amount_paise: depositPaise,
            p_type: 'deposit',
            p_method: depositMethod,
            p_reference: depositRef.trim() || null,
            p_note: 'Collected at pickup',
            p_receipt_document_id: null,
            p_received_at: null,
          });
        } catch (err) {
          depositError = errorMessage(err);
        }
      }
      toast.success('Car handed over. The booking is now Active.');
      if (depositError) {
        toast.error(`The deposit wasn't saved: ${depositError} Record it under Payments.`, { duration: 10_000 });
      }
      await refresh('documents', 'payments');
      onClose();
    } catch (err) {
      const ae = toAppError(err);
      setFormError(ae.code === 'pickup_gate' ? `Pickup checks not passed: ${ae.message} Close this form and fix them first.` : ae.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex flex-col gap-8">
        <section className="flex flex-col gap-3" aria-labelledby="hnd-checks">
          <StepHeading n={1} id="hnd-checks">
            Licence and identity
          </StepHeading>
          {gateProblems.length === 0 ? (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              <li className="flex items-center gap-2">
                <CheckCircle2 size={20} className="text-emerald-700" aria-hidden="true" /> Driving licence verified and valid past the return time
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle2 size={20} className="text-emerald-700" aria-hidden="true" /> Identity verified
              </li>
            </ul>
          ) : (
            <Alert tone="warning" title="Handing over with the Owner's override">
              <ul className="m-0 pl-5">
                {gateProblems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
              <p className="m-0 mt-2">Reason: {overrideReason}</p>
            </Alert>
          )}
          <p className="m-0 text-sm text-muted">Check the person collecting the car is the customer on the licence.</p>
        </section>

        <section className="flex flex-col gap-4" aria-labelledby="hnd-readings">
          <StepHeading n={2} id="hnd-readings">
            Odometer and fuel
          </StepHeading>
          <Field label="Odometer (km)" required error={errors.odometer}>
            <Input inputMode="numeric" autoComplete="off" value={odometer} onChange={(e) => setOdometer(e.target.value)} className="max-w-xs" />
          </Field>
          <FuelPicker value={fuel} onChange={setFuel} error={errors.fuel} />
        </section>

        <section className="flex flex-col gap-3" aria-labelledby="hnd-photos">
          <StepHeading n={3} id="hnd-photos">
            Photos
          </StepHeading>
          <p className="m-0 text-sm text-muted">All four sides, the interior, the odometer and the fuel gauge. Each photo is saved to the booking straight away.</p>
          <PhotoSlots uploads={photos} slots={PHOTO_SLOTS} label="Pickup photos" />
          {errors.photos && <p className="m-0 text-sm font-semibold text-danger">{errors.photos}</p>}
          {missingPhotos.length > 0 && missingPhotos.length < PHOTO_SLOTS.length && (
            <p className="m-0 text-sm text-amber-900">Still missing: {missingPhotos.map((s) => s.label).join(', ')}.</p>
          )}
        </section>

        <section className="flex flex-col gap-4" aria-labelledby="hnd-condition">
          <StepHeading n={4} id="hnd-condition">
            Condition and accessories
          </StepHeading>
          <Field label="Existing damage" optional hint="Scratches, dents or anything not working, with where it is. Leave blank if none.">
            <Textarea value={damage} onChange={(e) => setDamage(e.target.value)} rows={3} />
          </Field>
          <fieldset className="m-0 border-0 p-0">
            <legend className="mb-1 p-0 font-semibold">In the car</legend>
            {ACCESSORIES.map((a) => (
              <Checkbox
                key={a.key}
                label={a.label}
                checked={accessories[a.key]}
                onChange={(ev) => {
                  const checked = ev.target.checked;
                  setAccessories((s) => ({ ...s, [a.key]: checked }));
                }}
              />
            ))}
          </fieldset>
        </section>

        <section className="flex flex-col gap-4" aria-labelledby="hnd-deposit">
          <StepHeading n={5} id="hnd-deposit">
            Deposit
          </StepHeading>
          <p className="m-0 text-sm text-muted">
            Required {formatRupees(booking.deposit_paise)}
            {ledger.depositHeld > 0 ? `, already held ${formatRupees(ledger.depositHeld)}` : ''}. Leave blank if no deposit is collected now.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Deposit collected now" optional error={errors.deposit}>
              <MoneyInput value={deposit} onChange={(e) => setDeposit(e.target.value)} />
            </Field>
            <Field label="Reference" optional hint="UPI or card reference.">
              <Input value={depositRef} onChange={(e) => setDepositRef(e.target.value)} autoComplete="off" />
            </Field>
          </div>
          <ChoiceChips legend="Paid by" options={METHOD_OPTIONS} value={depositMethod} onChange={setDepositMethod} />
        </section>

        <section className="flex flex-col gap-4" aria-labelledby="hnd-sign">
          <StepHeading n={6} id="hnd-sign">
            Customer signature
          </StepHeading>
          <SignaturePad
            label="Customer's signature"
            hint="Hand the phone to the customer. They sign with a finger to accept the car's condition and the terms of rental."
            error={errors.signature}
            onChange={changeSignature}
          />
          <Checkbox
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
            error={errors.accepted}
            label="The customer accepted the car's condition and the terms of rental."
          />
        </section>
        {formError && <Alert>{formError}</Alert>}
      </div>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={submit} loading={busy} loadingText="Saving…" icon={<KeyRound size={18} aria-hidden="true" />}>
          Hand over car
        </Button>
      </DialogFooter>
    </>
  );
}
