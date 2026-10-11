// /admin/bookings/:code — everything about one booking on one screen (BKA-03): status actions
// (BKA-04), pickup checks (DOC-09), handover and return (HND-01..04), money (PAY-01..03),
// documents and the timeline. Staff use it at the counter, so it is built phone-first (ADM-08).
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft, CalendarPlus, PencilLine, Plus, Printer, Wallet } from 'lucide-react';
import toast from 'react-hot-toast';
import { displayStatus, isEditable } from '@shared/booking.ts';
import { SOURCE_LABELS } from '@shared/constants.ts';
import { DEFAULT_SETTINGS } from '@shared/settings.ts';
import { Badge, FlagPills, StatusPill, isStruck } from '@/components/ui/Badges';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Field';
import { Card, CardBody, CardHeader, EmptyState, PageHeader } from '@/components/ui/Layout';
import { PageSpinner } from '@/components/ui/Spinner';
import { cn } from '@/lib/cn';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatWhen } from '@/lib/format';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { useNow } from '@/lib/useNow';
import type { BookingWithRefs } from '@/types/db';
import { isOwnerOrManager, useAuth } from '../../auth/AuthProvider';
import { useDocumentIdleTimeout } from '../../auth/guards';
import { DocumentsPanel, useOwnerDocuments } from '../../components/documents/DocumentsPanel';
import { DocumentUploadDialog } from '../../components/documents/DocumentUploadDialog';
import { VerifyDocumentDialog, VerifyIdentityDialog } from '../../components/documents/VerifyDialogs';
import { useBookingByCode } from '../../hooks/bookings';
import { useSetting } from '../../hooks/queries';
import { useCustomerDetail, useGateProblems, useHandovers, useRefresh } from './detail/api';
import { AddChargeDialog, ChargesCard } from './detail/Charges';
import { ContactActions } from './detail/ContactActions';
import { EditBookingDialog } from './detail/EditBookingDialog';
import { ExtendDialog } from './detail/ExtendDialog';
import { HandoverRecordsCard } from './detail/HandoverRecords';
import { canAddCharge, packageLabel, summaryFromRecords, type GateFix } from './detail/helpers';
import { HoldBanner, HoldControl, NotesCard } from './detail/NotesCard';
import { PaymentsCard, RecordPaymentDialog } from './detail/Payments';
import { PickupChecksCard, PickupGateDialog } from './detail/PickupChecks';
import { PickupHandoverDialog } from './detail/PickupHandoverDialog';
import { ReturnDialog } from './detail/ReturnDialog';
import { SettlementPanel } from './detail/Settlement';
import { StatusActions } from './detail/StatusActions';
import { CarCard, CustomerCard, MoneyCard, TripCard } from './detail/SummaryCards';
import { Timeline } from './detail/Timeline';

const BackLink = () => (
  <Link to="/admin/bookings" className="inline-flex min-h-11 items-center gap-1.5 self-start font-semibold">
    <ArrowLeft size={18} aria-hidden="true" /> Bookings
  </Link>
);

export default function BookingDetailPage() {
  // ADM-05: this screen shows customer documents.
  useDocumentIdleTimeout();
  const { code } = useParams();
  const booking = useBookingByCode(code);

  if (booking.isLoading) return <PageSpinner label="Loading booking" />;
  if (booking.error && !booking.data) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <Alert title="Couldn't load this booking">{errorMessage(booking.error)}</Alert>
        <div>
          <Button variant="secondary" onClick={() => void booking.refetch()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
  if (!booking.data) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <EmptyState title={`Booking ${code ?? ''} not found`}>
          Check the code. Staff see bookings from yesterday to tomorrow, and any car still out on a trip.
        </EmptyState>
      </div>
    );
  }
  return <BookingDetail booking={booking.data} />;
}

type DialogKind = null | 'gate' | 'pickup' | 'return' | 'edit' | 'extend' | 'payment' | 'charge';

function BookingDetail({ booking }: { booking: BookingWithRefs }) {
  useDocumentMeta({ title: `${booking.booking_code} – KSR admin`, noindex: true });
  const { role } = useAuth();
  const om = isOwnerOrManager(role);
  const now = useNow(30_000);
  const refresh = useRefresh();
  const status = displayStatus(booking, now);
  const rules = useSetting('booking_rules').data ?? DEFAULT_SETTINGS.booking_rules;

  const customerId = booking.customer?.id ?? null;
  const customer = useCustomerDetail(customerId);
  const handovers = useHandovers(booking.id);
  const records = handovers.data ?? [];
  const pickupRecord = records.find((r) => r.kind === 'pickup');
  const returnRecord = records.find((r) => r.kind === 'return');
  const gate = useGateProblems(booking.id, booking.status === 'confirmed');
  const customerDocs = useOwnerDocuments('customer', customerId);
  const licence = (customerDocs.data ?? []).find((d) => d.doc_type === 'dl_front' && d.status !== 'superseded' && !d.deleted_at);

  const [dialog, setDialog] = useState<DialogKind>(null);
  const [gateSnapshot, setGateSnapshot] = useState<string[]>([]);
  const [override, setOverride] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [fix, setFix] = useState<GateFix | null>(null);
  const [identityOpen, setIdentityOpen] = useState(false);
  const close = () => setDialog(null);

  // AC-09: check the gate first; with open problems, show them (and their fixes) before the checklist.
  async function startPickup() {
    setChecking(true);
    try {
      const res = await gate.refetch();
      if (res.error) throw res.error;
      const problems = res.data ?? [];
      setGateSnapshot(problems);
      setOverride(null);
      setDialog(problems.length ? 'gate' : 'pickup');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setChecking(false);
    }
  }

  function applyFix(f: GateFix) {
    setDialog(null);
    if (f.kind === 'identity') setIdentityOpen(true);
    else setFix(f);
  }

  const canEdit = om && isEditable(booking.status);
  const canExtend = om && booking.status === 'active';
  const canCharge = canAddCharge(booking.status, om);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        back={<BackLink />}
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span className={cn('font-mono tracking-tight', isStruck(status) && 'text-muted line-through')}>{booking.booking_code}</span>
            <StatusPill status={status} className="text-[15px]" />
          </span>
        }
        description={
          <>
            <span className="flex flex-wrap items-center gap-2">
              <span>
                {booking.car?.display_name ?? 'Car'} · {packageLabel(booking)} · {formatWhen(booking.pickup_at)}
              </span>
              <FlagPills flags={booking.flags} />
              {booking.on_hold && <Badge tone="dark">On hold</Badge>}
            </span>
            <span className="mt-1 block text-sm">
              {SOURCE_LABELS[booking.source]} · created {formatDateTime(booking.created_at)}
            </span>
          </>
        }
        actions={
          <>
            <ContactActions booking={booking} />
            <ButtonLink to={`/admin/bookings/${booking.booking_code}/print`} variant="ghost" size="sm" icon={<Printer size={16} aria-hidden="true" />}>
              Print
            </ButtonLink>
          </>
        }
      />

      {(booking.status === 'rejected' || booking.status === 'cancelled') && booking.cancel_reason && (
        <Alert tone="info" title={booking.status === 'rejected' ? 'Rejected' : 'Cancelled'}>
          {booking.cancel_reason}
        </Alert>
      )}
      <HoldBanner booking={booking} />

      <Card>
        <CardBody className="flex flex-col gap-4">
          <StatusActions
            booking={booking}
            role={role}
            now={now}
            customerBlocked={Boolean(customer.data?.blocked ?? booking.customer?.blocked)}
            blockReason={customer.data?.block_reason ?? null}
            onPickup={() => void startPickup()}
            onReturn={() => setDialog('return')}
            pickupBusy={checking}
          />
          <div className="flex flex-wrap gap-2 border-t border-line-card pt-4 first:border-t-0 first:pt-0">
            {canEdit && (
              <Button variant="secondary" size="sm" icon={<PencilLine size={16} aria-hidden="true" />} onClick={() => setDialog('edit')}>
                Edit booking
              </Button>
            )}
            {canExtend && (
              <Button variant="secondary" size="sm" icon={<CalendarPlus size={16} aria-hidden="true" />} onClick={() => setDialog('extend')}>
                Extend
              </Button>
            )}
            <Button variant="secondary" size="sm" icon={<Wallet size={16} aria-hidden="true" />} onClick={() => setDialog('payment')}>
              Record payment
            </Button>
            {canCharge && (
              <Button variant="secondary" size="sm" icon={<Plus size={16} aria-hidden="true" />} onClick={() => setDialog('charge')}>
                Add charge
              </Button>
            )}
            {om && <HoldControl booking={booking} />}
          </div>
        </CardBody>
      </Card>

      {booking.status === 'confirmed' && (
        <PickupChecksCard
          problems={gate.data}
          loading={gate.isLoading}
          error={gate.error}
          licence={licence}
          canFix={Boolean(customerId)}
          onFix={applyFix}
        />
      )}

      {booking.status === 'returned' && dialog !== 'return' && (
        <Card>
          <CardHeader title="Settle up" description="Add any charges, then refund the deposit and close the booking." />
          <CardBody>
            <SettlementPanel booking={booking} summary={summaryFromRecords(booking, pickupRecord, returnRecord, rules)} />
          </CardBody>
        </Card>
      )}

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(320px,400px)]">
        <div className="flex min-w-0 flex-col gap-5">
          <div className="grid gap-5 md:grid-cols-2">
            <CustomerCard booking={booking} customer={customer.data} om={om} onVerifyIdentity={() => setIdentityOpen(true)} />
            <CarCard booking={booking} om={om} />
            <TripCard booking={booking} now={now} rules={rules} />
            <MoneyCard booking={booking} />
          </div>
          <HandoverRecordsCard records={records} />
          <ChargesCard booking={booking} onAdd={() => setDialog('charge')} />
          <PaymentsCard booking={booking} onRecord={() => setDialog('payment')} />
          <DocumentsPanel ownerType="booking" ownerId={booking.id} contextBookingId={booking.id} title="Booking documents" />
          {customerId && (
            <DocumentsPanel ownerType="customer" ownerId={customerId} contextBookingId={booking.id} expected={['dl_front']} title="Customer documents" />
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <NotesCard booking={booking} om={om} />
          <Timeline bookingId={booking.id} />
        </div>
      </div>

      <PickupGateDialog
        open={dialog === 'gate'}
        onClose={close}
        problems={gateSnapshot}
        licence={licence}
        canFix={Boolean(customerId)}
        role={role}
        onFix={applyFix}
        onOverride={(reason) => {
          setOverride(reason);
          setDialog('pickup');
        }}
      />
      <PickupHandoverDialog open={dialog === 'pickup'} onClose={close} booking={booking} gateProblems={gateSnapshot} overrideReason={override} />
      <ReturnDialog open={dialog === 'return'} onClose={close} booking={booking} pickup={pickupRecord} />
      {canEdit && <EditBookingDialog open={dialog === 'edit'} onClose={close} booking={booking} />}
      {canExtend && <ExtendDialog open={dialog === 'extend'} onClose={close} booking={booking} />}
      <RecordPaymentDialog open={dialog === 'payment'} onClose={close} booking={booking} />
      <AddChargeDialog open={dialog === 'charge'} onClose={close} booking={booking} />

      {customerId && (
        <>
          <VerifyIdentityDialog customerId={customerId} bookingId={booking.id} open={identityOpen} onClose={() => setIdentityOpen(false)} />
          <VerifyDocumentDialog
            doc={fix?.kind === 'verify_licence' ? fix.doc : null}
            label="Driving licence – front"
            open={fix?.kind === 'verify_licence'}
            onClose={() => setFix(null)}
          />
          <DocumentUploadDialog
            open={fix?.kind === 'upload_licence'}
            onClose={() => setFix(null)}
            ownerType="customer"
            ownerId={customerId}
            allowedTypes={['dl_front']}
            defaultType="dl_front"
            replaces={fix?.kind === 'upload_licence' ? fix.replaces : null}
            contextBookingId={booking.id}
            onUploaded={() => void refresh()}
          />
        </>
      )}
    </div>
  );
}
