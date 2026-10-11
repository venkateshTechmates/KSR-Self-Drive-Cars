// HND-03/04: return checklist (same readings and photos as pickup), then the settlement:
// km driven, fuel difference, late hours with suggested charges, and the deposit refund.
import { useState } from 'react';
import { Undo2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { FUEL_LEVEL_LABELS, type FuelLevel } from '@shared/constants.ts';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogFooter } from '@/components/ui/Dialog';
import { Alert, Checkbox, Field, Input, Textarea } from '@/components/ui/Field';
import { uploadDocument } from '@/lib/documents';
import { toAppError } from '@/lib/errors';
import type { BookingWithRefs, HandoverChecklist, HandoverRecord, ReturnSummary } from '@/types/db';
import { isOwnerOrManager, useAuth } from '@/admin/auth/AuthProvider';
import { rpc, useRefresh } from './api';
import { ACCESSORIES, FUEL_SPOKEN, PHOTO_SLOTS, parseKm, type AccessoryKey, type SettlementSummary } from './helpers';
import { PhotoSlots } from './PhotoSlots';
import { usePhotoUploads } from './usePhotoUploads';
import { SettlementPanel } from './Settlement';
import { SignaturePad } from './SignaturePad';
import { FuelPicker, StepHeading } from './ui';

const DAMAGE_SLOT = [{ key: 'damage', label: 'New damage' }] as const;

interface Props {
  open: boolean;
  onClose: () => void;
  booking: BookingWithRefs;
  pickup: HandoverRecord | undefined;
}

export function ReturnDialog(props: Props) {
  const [busy, setBusy] = useState(false);
  const { booking } = props;
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      locked={busy}
      size="lg"
      title="Car returned"
      description={`${booking.car?.display_name ?? 'Car'} · ${booking.booking_code}${booking.customer ? ` · ${booking.customer.full_name}` : ''}`}
    >
      <ReturnFlow {...props} busy={busy} setBusy={setBusy} />
    </Dialog>
  );
}

function ReturnFlow(props: Props & { busy: boolean; setBusy: (b: boolean) => void }) {
  const [summary, setSummary] = useState<SettlementSummary | null>(null);
  if (summary) {
    return (
      <>
        <Alert tone="success" title="Return recorded" className="mb-5">
          Add any charges below, then settle the deposit.
        </Alert>
        <SettlementPanel booking={props.booking} summary={summary} allowRemove={false} />
        <DialogFooter>
          <Button onClick={props.onClose}>Done</Button>
        </DialogFooter>
      </>
    );
  }
  return <ReturnForm {...props} onReturned={setSummary} />;
}

function ReturnForm({
  booking,
  pickup,
  onClose,
  busy,
  setBusy,
  onReturned,
}: Props & { busy: boolean; setBusy: (b: boolean) => void; onReturned: (s: SettlementSummary) => void }) {
  const { role } = useAuth();
  const om = isOwnerOrManager(role);
  const refresh = useRefresh();
  const photos = usePhotoUploads(booking.id, 'return_photos');
  const damagePhotos = usePhotoUploads(booking.id, 'damage_photos');

  const [odometer, setOdometer] = useState('');
  const [fuel, setFuel] = useState<FuelLevel | ''>('');
  const [damage, setDamage] = useState('');
  const [accessories, setAccessories] = useState<Record<AccessoryKey, boolean>>({ spare_wheel: false, jack: false, documents_in_car: false });
  const [signature, setSignature] = useState<Blob | null>(null);
  const [signatureDocId, setSignatureDocId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const pickupAccessories = pickup?.checklist.accessories;

  function changeSignature(png: Blob | null) {
    setSignature(png);
    setSignatureDocId(null);
  }

  async function submit() {
    const e: Record<string, string> = {};
    const km = parseKm(odometer);
    if (km === null) e.odometer = 'Enter the odometer reading in whole km, for example 45390.';
    else if (pickup && km < pickup.odometer_km) e.odometer = `The reading is lower than at pickup (${pickup.odometer_km.toLocaleString('en-IN')} km). Check it again.`;
    if (!fuel) e.fuel = 'Choose the fuel level.';
    if (photos.busy || damagePhotos.busy) e.photos = 'Wait for the photos to finish uploading.';
    setErrors(e);
    setFormError(null);
    if (Object.keys(e).length) {
      setFormError(`Check ${Object.keys(e).length === 1 ? 'the highlighted field' : `the ${Object.keys(e).length} highlighted fields`} above.`);
      return;
    }

    setBusy(true);
    try {
      // Reuse the signature saved by an earlier attempt: uploading the same file again is refused as a duplicate.
      let sigId = signatureDocId;
      if (!sigId && signature) {
        const res = await uploadDocument({
          ownerType: 'booking',
          ownerId: booking.id,
          docType: 'signature',
          file: new File([signature], 'signature.png', { type: 'image/png' }),
          prepared: true,
          notes: 'Customer signature at return',
        });
        sigId = res.document.id;
        setSignatureDocId(sigId);
      }
      const checklist: HandoverChecklist = {
        photos: Object.fromEntries(PHOTO_SLOTS.map((s) => [s.key, photos.has(s.key)])),
        photo_count: photos.total,
        damage_photo_count: damagePhotos.total,
        accessories,
        new_damage: Boolean(damage.trim()),
      };
      const res = await rpc<ReturnSummary>('record_handover', {
        p_booking: booking.id,
        p_kind: 'return',
        p_odometer_km: km,
        p_fuel_level: fuel,
        p_checklist: checklist,
        p_damage_notes: damage.trim(),
        p_signature_document_id: sigId,
        p_override_reason: null,
      });
      toast.success('Return recorded. The booking is now Returned.');
      await refresh('documents');
      onReturned({
        km_driven: res.km_driven,
        fuel_diff_quarters: res.fuel_diff_quarters,
        late_hours: res.late_hours,
        suggested_late_fee_paise: res.suggested_late_fee_paise,
        extra_km: res.extra_km,
        suggested_km_charge_paise: res.suggested_km_charge_paise,
        deposit_held_paise: res.deposit_held_paise,
      });
    } catch (err) {
      const ae = toAppError(err);
      if (ae.code === 'odometer_km') setErrors({ odometer: ae.message });
      setFormError(ae.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex flex-col gap-8">
        <section className="flex flex-col gap-4" aria-labelledby="ret-readings">
          <StepHeading n={1} id="ret-readings">
            Odometer and fuel
          </StepHeading>
          <Field
            label="Odometer (km)"
            required
            error={errors.odometer}
            hint={pickup ? `At pickup: ${pickup.odometer_km.toLocaleString('en-IN')} km.` : undefined}
          >
            <Input inputMode="numeric" autoComplete="off" value={odometer} onChange={(e) => setOdometer(e.target.value)} className="max-w-xs" />
          </Field>
          <FuelPicker
            value={fuel}
            onChange={setFuel}
            error={errors.fuel}
            hint={
              pickup ? (
                <>
                  At pickup: <span aria-hidden="true">{FUEL_LEVEL_LABELS[pickup.fuel_level]}</span>
                  <span className="sr-only">{FUEL_SPOKEN[pickup.fuel_level]}</span>.
                </>
              ) : undefined
            }
          />
        </section>

        <section className="flex flex-col gap-3" aria-labelledby="ret-photos">
          <StepHeading n={2} id="ret-photos">
            Photos
          </StepHeading>
          <PhotoSlots uploads={photos} slots={PHOTO_SLOTS} label="Return photos" />
          {errors.photos && <p className="m-0 text-sm font-semibold text-danger">{errors.photos}</p>}
        </section>

        <section className="flex flex-col gap-4" aria-labelledby="ret-condition">
          <StepHeading n={3} id="ret-condition">
            New damage and accessories
          </StepHeading>
          {pickup?.damage_notes && (
            <p className="m-0 rounded-xl bg-subtle px-4 py-3 text-[15px]">
              <span className="font-semibold">Damage noted at pickup:</span> {pickup.damage_notes}
            </p>
          )}
          <Field label="New damage" optional hint="Anything not noted at pickup, with where it is. Leave blank if none.">
            <Textarea value={damage} onChange={(e) => setDamage(e.target.value)} rows={3} />
          </Field>
          {om ? (
            <div className="flex flex-col gap-2">
              <span className="font-semibold">
                Damage photos <span className="font-normal text-muted">(optional, seen by the Owner and Managers only)</span>
              </span>
              <PhotoSlots uploads={damagePhotos} slots={DAMAGE_SLOT} label="Damage photos" />
            </div>
          ) : (
            damage.trim() && <p className="m-0 text-sm text-muted">Take return photos that show the damage. The Owner or a Manager can add a damage charge.</p>
          )}
          <fieldset className="m-0 border-0 p-0">
            <legend className="mb-1 p-0 font-semibold">Returned with the car</legend>
            {ACCESSORIES.map((a) => (
              <Checkbox
                key={a.key}
                label={a.label}
                description={pickupAccessories && pickupAccessories[a.key] === false ? 'Not in the car at pickup.' : undefined}
                checked={accessories[a.key]}
                onChange={(ev) => {
                  const checked = ev.target.checked;
                  setAccessories((s) => ({ ...s, [a.key]: checked }));
                }}
              />
            ))}
          </fieldset>
        </section>

        <section className="flex flex-col gap-4" aria-labelledby="ret-sign">
          <StepHeading n={4} id="ret-sign">
            Customer signature <span className="font-normal text-muted">(optional)</span>
          </StepHeading>
          <SignaturePad label="Customer's signature" hint="The customer signs to agree the return readings." onChange={changeSignature} />
        </section>
        {formError && <Alert>{formError}</Alert>}
      </div>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={submit} loading={busy} loadingText="Saving…" icon={<Undo2 size={18} aria-hidden="true" />}>
          Record return
        </Button>
      </DialogFooter>
    </>
  );
}
