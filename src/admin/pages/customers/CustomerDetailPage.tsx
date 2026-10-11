// Customer detail (CUS-03..06): contact, licence, identity, blocklist, documents, bookings, payments, consents, data rights.
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft, Link2, MessageCircle, Phone } from 'lucide-react';
import { Badge } from '@/components/ui/Badges';
import { AnchorButton, Button, ButtonLink } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Field';
import { EmptyState, PageHeader } from '@/components/ui/Layout';
import { PageSpinner } from '@/components/ui/Spinner';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatPhone, telHref, whatsappHref } from '@/lib/format';
import { useDocumentIdleTimeout } from '../../auth/guards';
import { DocumentsPanel } from '../../components/documents/DocumentsPanel';
import { BookingsCard, ConsentsCard, PaymentsCard } from './CustomerActivityCards';
import { useCustomer, useCustomerBookings, useCustomerConsents, useCustomerPayments } from './customerData';
import { DataRightsCard } from './CustomerDataRights';
import { BlocklistCard, ContactCard, IdentityCard } from './CustomerProfileCards';
import { UploadLinkDialog } from './UploadLinkDialog';

const EXPECTED_DOCS = ['dl_front', 'dl_back'];

function BackLink() {
  return (
    <Link to="/admin/customers" className="inline-flex min-h-11 items-center gap-1.5 self-start font-semibold text-ink">
      <ArrowLeft size={18} aria-hidden="true" />
      Customers
    </Link>
  );
}

export default function CustomerDetailPage() {
  useDocumentIdleTimeout();
  const { id } = useParams();
  // Keyed so every bit of local state starts fresh when moving between customers (e.g. after a merge).
  return id ? <CustomerDetail key={id} id={id} /> : null;
}

function CustomerDetail({ id }: { id: string }) {
  const customerQ = useCustomer(id);
  const bookingsQ = useCustomerBookings(id);
  const bookingIds = useMemo(() => (bookingsQ.data ?? []).map((b) => b.id), [bookingsQ.data]);
  const paymentsQ = useCustomerPayments(id, bookingIds);
  const consentsQ = useCustomerConsents(id);
  const [linkOpen, setLinkOpen] = useState(false);

  if (customerQ.isLoading) return <PageSpinner label="Loading customer" />;
  if (customerQ.error) {
    return (
      <>
        <PageHeader title="Customer" back={<BackLink />} />
        <Alert>{errorMessage(customerQ.error)}</Alert>
      </>
    );
  }
  const customer = customerQ.data;
  if (!customer) {
    return (
      <>
        <PageHeader title="Customer" back={<BackLink />} />
        <EmptyState title="Customer not found" action={<ButtonLink to="/admin/customers">Back to customers</ButtonLink>}>
          The record may have been merged into another one. Search for the customer by mobile number.
        </EmptyState>
      </>
    );
  }

  const erased = Boolean(customer.erased_at);

  return (
    <>
      <PageHeader
        back={<BackLink />}
        title={customer.full_name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {customer.phone && <span>{formatPhone(customer.phone)}</span>}
            {erased && <Badge tone="grey">Erased</Badge>}
            {customer.blocked && <Badge tone="red">Blocked</Badge>}
            {!erased &&
              (customer.identity_verified ? <Badge tone="green">ID verified</Badge> : <Badge tone="outline">ID not verified</Badge>)}
          </span>
        }
        actions={
          !erased &&
          customer.phone && (
            <>
              <AnchorButton variant="secondary" size="sm" href={telHref(customer.phone)} icon={<Phone size={16} aria-hidden="true" />}>
                Call
              </AnchorButton>
              <AnchorButton
                variant="secondary"
                size="sm"
                href={whatsappHref(customer.phone)}
                target="_blank"
                rel="noreferrer"
                icon={<MessageCircle size={16} aria-hidden="true" />}
              >
                WhatsApp
              </AnchorButton>
              <Button size="sm" icon={<Link2 size={16} aria-hidden="true" />} onClick={() => setLinkOpen(true)}>
                Send upload link
              </Button>
            </>
          )
        }
      />

      <div className="flex flex-col gap-5">
        {erased && (
          <Alert tone="info" title="Personal data erased">
            Erased on {formatDateTime(customer.erased_at!)}. Bookings and payments are kept for accounts but no longer linked to a name. Files are
            erased by the nightly job.
          </Alert>
        )}
        {customer.blocked && (
          <Alert tone="error" title="Blocked customer">
            <p className="m-0">Reason: {customer.block_reason}</p>
            <p className="m-0 mt-1">New booking requests from this number are flagged. To unblock, use Blocklist below.</p>
          </Alert>
        )}

        <div className="grid gap-5 lg:grid-cols-2">
          <ContactCard customer={customer} readOnly={erased} />
          <div className="flex flex-col gap-5">
            <IdentityCard customer={customer} readOnly={erased} />
            <BlocklistCard customer={customer} readOnly={erased} />
          </div>
        </div>

        <DocumentsPanel ownerType="customer" ownerId={customer.id} expected={erased ? [] : EXPECTED_DOCS} title="Documents" readOnly={erased} />
        <BookingsCard bookings={bookingsQ} />
        <PaymentsCard payments={paymentsQ} bookings={bookingsQ.data ?? []} />
        <ConsentsCard consents={consentsQ} />
        <DataRightsCard customer={customer} />
      </div>

      {!erased && <UploadLinkDialog open={linkOpen} onClose={() => setLinkOpen(false)} customer={customer} bookings={bookingsQ.data ?? []} />}
    </>
  );
}
