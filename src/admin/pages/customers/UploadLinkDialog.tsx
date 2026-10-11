// DOC-16: one-time link for the customer to upload licence photos and a masked Aadhaar before pickup.
import { useState } from 'react';
import { Copy, MessageCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { AnchorButton, Button } from '@/components/ui/Button';
import { Dialog, DialogFooter } from '@/components/ui/Dialog';
import { Alert, Field, Input, Select } from '@/components/ui/Field';
import { createUploadLink, type UploadLinkResult } from '@/lib/documents';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatWhen, whatsappHref } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import type { Customer } from '@/types/db';
import type { CustomerBooking } from './customerData';

interface Props {
  open: boolean;
  onClose: () => void;
  customer: Customer;
  bookings: CustomerBooking[];
}

export function UploadLinkDialog({ open, onClose, customer, bookings }: Props) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      locked={busy}
      size="sm"
      title="Send upload link"
      description="The customer gets a one-time link to upload licence photos and a masked Aadhaar. It works for 24 hours."
    >
      <UploadLinkBody customer={customer} bookings={bookings} onClose={onClose} busy={busy} setBusy={setBusy} />
    </Dialog>
  );
}

function UploadLinkBody({
  customer,
  bookings,
  onClose,
  busy,
  setBusy,
}: Omit<Props, 'open'> & { busy: boolean; setBusy: (b: boolean) => void }) {
  const now = useNow();
  const upcoming = bookings
    .filter((b) => (b.status === 'requested' || b.status === 'confirmed') && Date.parse(b.pickup_at) > now)
    .sort((a, b) => a.pickup_at.localeCompare(b.pickup_at));
  const [bookingId, setBookingId] = useState(upcoming[0]?.id ?? '');
  const [link, setLink] = useState<UploadLinkResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setError(null);
    setBusy(true);
    try {
      setLink(await createUploadLink(customer.id, bookingId || null));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function copy(text: string, what: string) {
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success(`${what} copied`))
      .catch(() => toast.error("Couldn't copy. Select the text and copy it by hand."));
  }

  if (link) {
    const wa = whatsappHref(customer.phone, link.message);
    return (
      <>
        <div className="flex flex-col gap-4">
          <Alert tone="success" title="Link created">
            It works once and stops working on {formatDateTime(link.expires_at)}. Files arrive as Pending for you to verify.
          </Alert>
          <div className="flex flex-col gap-2">
            <Field label="Link">
              <Input value={link.url} readOnly onFocus={(e) => e.currentTarget.select()} className="font-mono text-[14px]" />
            </Field>
            <Button variant="secondary" size="sm" className="self-start" icon={<Copy size={16} aria-hidden="true" />} onClick={() => copy(link.url, 'Link')}>
              Copy link
            </Button>
          </div>
          <div>
            <p className="m-0 mb-1 font-semibold">Message</p>
            <p className="m-0 rounded-xl border border-line-card bg-subtle px-4 py-3 text-[15px] whitespace-pre-wrap">{link.message}</p>
          </div>
          <p className="m-0 text-sm text-muted">This is the only time the link is shown. If it gets lost, create a new one.</p>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => copy(link.message, 'Message')}>
            Copy message
          </Button>
          {wa && (
            <AnchorButton href={wa} target="_blank" rel="noreferrer" icon={<MessageCircle size={18} aria-hidden="true" />}>
              Send on WhatsApp
            </AnchorButton>
          )}
          <Button variant="ghost" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-4">
        {upcoming.length > 0 ? (
          <Field label="For booking" hint="Uploads are linked to this booking as well as the customer.">
            <Select value={bookingId} onChange={(e) => setBookingId(e.target.value)}>
              {upcoming.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.booking_code} · {b.car?.display_name ?? 'Car'} · {formatWhen(b.pickup_at)}
                </option>
              ))}
              <option value="">Not for a particular booking</option>
            </Select>
          </Field>
        ) : (
          <p className="m-0 text-muted">This customer has no upcoming booking, so the uploads are saved to the customer only.</p>
        )}
        {error && <Alert>{error}</Alert>}
      </div>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={create} loading={busy}>
          Create link
        </Button>
      </DialogFooter>
    </>
  );
}
