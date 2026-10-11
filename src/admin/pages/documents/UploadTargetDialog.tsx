// DOC-01: from the document centre, first choose what the upload belongs to.
import { useState } from 'react';
import { Search } from 'lucide-react';
import { DOC_OWNER_TYPES, type DocOwnerType } from '@shared/constants.ts';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogFooter } from '@/components/ui/Dialog';
import { Alert, Field, Input, Select } from '@/components/ui/Field';
import { supabase } from '@/integrations/supabase/client';
import { errorMessage, unwrap } from '@/lib/errors';
import { formatWhen } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { Customer } from '@/types/db';
import { useAuth } from '../../auth/AuthProvider';
import { useCars } from '../../hooks/queries';
import { CustomerPicker } from '../customers/CustomerPicker';

export interface UploadTarget {
  ownerType: DocOwnerType;
  ownerId: string | null;
  label: string;
}

const KIND_TEXT: Record<DocOwnerType, { label: string; hint: string }> = {
  customer: { label: 'A customer', hint: 'Driving licence, masked Aadhaar, other photo ID' },
  booking: { label: 'A booking', hint: 'Agreement, handover photos, receipts, fines, claims' },
  car: { label: 'A car', hint: 'RC, insurance, PUC, permit, service invoices' },
  business: { label: 'The business', hint: 'GST registration, trade licence, templates' },
};

interface FoundBooking {
  id: string;
  booking_code: string;
  pickup_at: string;
  car: { display_name: string } | null;
  customer: { full_name: string } | null;
}

export function UploadTargetDialog({ open, onClose, onChoose }: { open: boolean; onClose: () => void; onChoose: (t: UploadTarget) => void }) {
  return (
    <Dialog open={open} onClose={onClose} size="sm" title="Upload documents" description="First choose what the documents belong to.">
      <UploadTargetForm onClose={onClose} onChoose={onChoose} />
    </Dialog>
  );
}

function UploadTargetForm({ onClose, onChoose }: { onClose: () => void; onChoose: (t: UploadTarget) => void }) {
  const { role } = useAuth();
  const { data: cars = [] } = useCars();
  const [kind, setKind] = useState<DocOwnerType>('customer');
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [code, setCode] = useState('');
  const [booking, setBooking] = useState<FoundBooking | null>(null);
  const [finding, setFinding] = useState(false);
  const [carId, setCarId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const kinds = DOC_OWNER_TYPES.filter((k) => k !== 'business' || role === 'owner');

  async function findBooking() {
    const c = code.trim().toUpperCase().replace(/\s/g, '');
    if (!c) return setError('Enter the booking code, for example KSR-261012-004.');
    setError(null);
    setFinding(true);
    try {
      const found = unwrap(
        await supabase
          .from('bookings')
          .select('id, booking_code, pickup_at, car:cars(display_name), customer:customers(full_name)')
          .eq('booking_code', c)
          .maybeSingle(),
      ) as unknown as FoundBooking | null;
      if (found) setBooking(found);
      else setError(`No booking has the code ${c}. Check the code and try again.`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setFinding(false);
    }
  }

  function next() {
    setError(null);
    if (kind === 'customer') {
      if (!customer) return setError('Find and choose the customer.');
      return onChoose({ ownerType: 'customer', ownerId: customer.id, label: customer.full_name });
    }
    if (kind === 'booking') {
      if (!booking) return setError('Find the booking by its code.');
      return onChoose({ ownerType: 'booking', ownerId: booking.id, label: booking.booking_code });
    }
    if (kind === 'car') {
      const car = cars.find((c) => c.id === carId);
      if (!car) return setError('Choose the car.');
      return onChoose({ ownerType: 'car', ownerId: car.id, label: car.display_name });
    }
    onChoose({ ownerType: 'business', ownerId: null, label: 'Business' });
  }

  return (
    <>
      <div className="flex flex-col gap-5">
        <fieldset className="m-0 border-0 p-0">
          <legend className="mb-2 font-semibold">It belongs to</legend>
          <div className="flex flex-col gap-2">
            {kinds.map((k) => (
              <label
                key={k}
                className={cn(
                  'flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border bg-white px-4 py-3',
                  kind === k ? 'border-ink ring-1 ring-ink' : 'border-line-input',
                )}
              >
                <input
                  type="radio"
                  name="owner-kind"
                  checked={kind === k}
                  onChange={() => {
                    setKind(k);
                    setError(null);
                  }}
                  className="mt-1 size-4 accent-ink"
                />
                <span>
                  <span className="block font-semibold">{KIND_TEXT[k].label}</span>
                  <span className="block text-sm text-muted">{KIND_TEXT[k].hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {kind === 'customer' && <CustomerPicker value={customer} onChange={setCustomer} />}

        {kind === 'booking' &&
          (booking ? (
            <div className="flex flex-col gap-2">
              <p className="m-0 font-semibold">Booking</p>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line-input bg-subtle px-4 py-3">
                <div className="min-w-0">
                  <p className="m-0 font-mono font-semibold">{booking.booking_code}</p>
                  <p className="m-0 text-sm text-muted">
                    {[booking.customer?.full_name, booking.car?.display_name, formatWhen(booking.pickup_at)].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setBooking(null)}>
                  Change
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Booking code" className="min-w-0 flex-1">
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void findBooking();
                    }
                  }}
                  placeholder="KSR-261012-004"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono uppercase"
                />
              </Field>
              <Button variant="secondary" onClick={findBooking} loading={finding} icon={<Search size={16} aria-hidden="true" />} className="min-h-[52px]">
                Find
              </Button>
            </div>
          ))}

        {kind === 'car' && (
          <Field label="Car">
            <Select value={carId} onChange={(e) => setCarId(e.target.value)}>
              <option value="">Choose a car</option>
              {cars.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.display_name}
                  {c.registration_number ? ` · ${c.registration_number}` : ''}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {error && <Alert>{error}</Alert>}
      </div>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={next}>Continue</Button>
      </DialogFooter>
    </>
  );
}
