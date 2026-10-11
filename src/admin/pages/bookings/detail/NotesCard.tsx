// Admin notes (Owner/Manager edit via update_booking) and the hold for an open fine, claim or dispute.
import { useState } from 'react';
import { Lock, PencilLine, Unlock } from 'lucide-react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { Alert, Field, Textarea } from '@/components/ui/Field';
import { Card, CardBody, CardHeader } from '@/components/ui/Layout';
import { errorMessage } from '@/lib/errors';
import type { BookingWithRefs } from '@/types/db';
import { rpc, useRefresh } from './api';

export function NotesCard({ booking, om }: { booking: BookingWithRefs; om: boolean }) {
  const refresh = useRefresh();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(booking.admin_notes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await rpc('update_booking', { p_booking: booking.id, p_admin_notes: draft });
      toast.success('Notes saved');
      await refresh();
      setEditing(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Admin notes"
        description="Only staff see these."
        actions={
          om &&
          !editing && (
            <Button
              variant="ghost"
              size="sm"
              icon={<PencilLine size={16} aria-hidden="true" />}
              onClick={() => {
                setDraft(booking.admin_notes);
                setEditing(true);
              }}
            >
              Edit notes
            </Button>
          )
        }
      />
      <CardBody>
        {editing ? (
          <div className="flex flex-col gap-3">
            <Field label="Notes" hideLabel error={error}>
              <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={5} autoFocus />
            </Field>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setEditing(false)} disabled={busy}>
                Cancel
              </Button>
              <Button size="sm" onClick={save} loading={busy}>
                Save notes
              </Button>
            </div>
          </div>
        ) : booking.admin_notes ? (
          <p className="m-0 break-words whitespace-pre-line">{booking.admin_notes}</p>
        ) : (
          <p className="m-0 text-muted">No notes.</p>
        )}
      </CardBody>
    </Card>
  );
}

/** Owner/Manager: hold the booking (and its documents) while a fine, claim or dispute is open (10.4). */
export function HoldControl({ booking }: { booking: BookingWithRefs }) {
  const refresh = useRefresh();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        icon={booking.on_hold ? <Unlock size={16} aria-hidden="true" /> : <Lock size={16} aria-hidden="true" />}
        onClick={() => setOpen(true)}
      >
        {booking.on_hold ? 'Remove hold' : 'Put on hold'}
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={booking.on_hold ? 'Remove the hold?' : 'Put this booking on hold?'}
        description={
          booking.on_hold
            ? 'Its documents will again be erased when their retention period ends.'
            : "Use this while a traffic fine, insurance claim or dispute is open. The booking's documents are not erased while it is on hold."
        }
        confirmLabel={booking.on_hold ? 'Remove hold' : 'Put on hold'}
        reasonLabel={booking.on_hold ? undefined : 'Reason'}
        reasonHint={booking.on_hold ? undefined : 'For example: challan received for 12 Oct, under review.'}
        onConfirm={async (reason) => {
          await rpc('set_booking_hold', { p_booking: booking.id, p_on_hold: !booking.on_hold, p_reason: booking.on_hold ? null : reason });
          toast.success(booking.on_hold ? 'Hold removed' : 'Booking on hold');
          await refresh();
        }}
      />
    </>
  );
}

export function HoldBanner({ booking }: { booking: BookingWithRefs }) {
  if (!booking.on_hold) return null;
  return (
    <Alert tone="warning" title="On hold">
      {booking.hold_reason ?? 'An open fine, claim or dispute.'} Documents for this booking are kept until the hold is removed.
    </Alert>
  );
}
