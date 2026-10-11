// Customers list (CUS-02): search by name, mobile or licence number; bookings, verification and blocklist at a glance.
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { DocStatus } from '@shared/constants.ts';
import { Badge } from '@/components/ui/Badges';
import { Button } from '@/components/ui/Button';
import { Alert, Field, Input } from '@/components/ui/Field';
import { Chip, DataTable, EmptyState, PageHeader, Toolbar, type Column } from '@/components/ui/Layout';
import { PageSpinner } from '@/components/ui/Spinner';
import { supabase } from '@/integrations/supabase/client';
import { errorMessage, toAppError, unwrap } from '@/lib/errors';
import { formatDate, formatPhone, pluralize } from '@/lib/format';
import type { Customer } from '@/types/db';
import { qk } from '../../hooks/queries';
import { customerSearchFilter, inChunks, useDebounced } from './customerSearch';

const PAGE = 50;

interface Activity {
  bookings: number;
  lastPickup: string | null;
}

/** Best current status of the customer's licence (front) upload. */
const DL_RANK: Record<DocStatus, number> = { verified: 4, pending: 3, rejected: 2, expired: 1, superseded: 0 };

export default function CustomersListPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 300);
  const [showErased, setShowErased] = useState(false);
  const [blockedOnly, setBlockedOnly] = useState(false);
  const [limit, setLimit] = useState(PAGE);

  const list = useQuery({
    queryKey: [...qk.customers, 'list', { q, showErased, blockedOnly, limit }],
    queryFn: async () => {
      let query = supabase.from('customers').select('*', { count: 'exact' });
      const filter = customerSearchFilter(q);
      if (filter) query = query.or(filter);
      if (!showErased) query = query.is('erased_at', null);
      if (blockedOnly) query = query.eq('blocked', true);
      query = filter ? query.order('full_name') : query.order('created_at', { ascending: false });
      const { data, error, count } = await query.range(0, limit - 1);
      if (error) throw toAppError(error);
      return { rows: (data ?? []) as Customer[], total: count ?? 0 };
    },
    placeholderData: keepPreviousData,
  });

  const rows = useMemo(() => list.data?.rows ?? [], [list.data]);
  const ids = useMemo(() => rows.map((c) => c.id), [rows]);

  const bookings = useQuery({
    queryKey: [...qk.bookings, 'by-customer', ids],
    enabled: ids.length > 0,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const found = await inChunks(ids, async (chunk) =>
        (unwrap(await supabase.from('bookings').select('customer_id, pickup_at').in('customer_id', chunk)) ?? []) as Array<{
          customer_id: string;
          pickup_at: string;
        }>,
      );
      const map = new Map<string, Activity>();
      for (const b of found) {
        const a = map.get(b.customer_id) ?? { bookings: 0, lastPickup: null };
        a.bookings += 1;
        if (!a.lastPickup || b.pickup_at > a.lastPickup) a.lastPickup = b.pickup_at;
        map.set(b.customer_id, a);
      }
      return map;
    },
  });

  const licences = useQuery({
    queryKey: [...qk.documents, 'dl-status', ids],
    enabled: ids.length > 0,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const found = await inChunks(ids, async (chunk) =>
        (unwrap(
          await supabase
            .from('documents')
            .select('customer_id, status')
            .in('customer_id', chunk)
            .eq('owner_type', 'customer')
            .eq('doc_type', 'dl_front')
            .is('deleted_at', null)
            .neq('status', 'superseded'),
        ) ?? []) as Array<{ customer_id: string; status: DocStatus }>,
      );
      const map = new Map<string, DocStatus>();
      for (const d of found) {
        const prev = map.get(d.customer_id);
        if (!prev || DL_RANK[d.status] > DL_RANK[prev]) map.set(d.customer_id, d.status);
      }
      return map;
    },
  });

  const activity = (id: string) => bookings.data?.get(id);

  const columns: Column<Customer>[] = [
    {
      key: 'name',
      header: 'Name',
      hideOnMobile: true,
      cell: (c) => <CustomerName customer={c} />,
    },
    { key: 'mobile', header: 'Mobile', cell: (c) => (c.phone ? <span className="whitespace-nowrap">{formatPhone(c.phone)}</span> : '—') },
    { key: 'bookings', header: 'Bookings', cell: (c) => activity(c.id)?.bookings ?? 0 },
    {
      key: 'last',
      header: 'Last booking',
      cell: (c) => {
        const last = activity(c.id)?.lastPickup;
        return last ? <span className="whitespace-nowrap">{formatDate(last)}</span> : '—';
      },
    },
    {
      key: 'verification',
      header: 'Verification',
      cell: (c) => (c.erased_at ? '—' : <VerificationBadges customer={c} licence={licences.data?.get(c.id) ?? null} />),
    },
    {
      key: 'blocked',
      header: 'Blocklist',
      cell: (c) => (c.blocked ? <Badge tone="red">Blocked</Badge> : <span className="text-muted">Not blocked</span>),
    },
  ];

  const total = list.data?.total ?? 0;

  return (
    <>
      <PageHeader title="Customers" description="One record per mobile number. Open a customer to see documents, bookings and payments." />
      <Toolbar>
        <Field label="Search" className="w-full sm:w-96" hint="Name, mobile or licence number">
          <Input
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setLimit(PAGE);
            }}
            autoComplete="off"
            placeholder="For example: Ravi or 98765"
          />
        </Field>
        <div className="flex flex-wrap gap-2 pb-0.5">
          <Chip
            pressed={blockedOnly}
            onClick={() => {
              setBlockedOnly((v) => !v);
              setLimit(PAGE);
            }}
          >
            Blocked only
          </Chip>
          <Chip
            pressed={showErased}
            onClick={() => {
              setShowErased((v) => !v);
              setLimit(PAGE);
            }}
          >
            Show erased
          </Chip>
        </div>
      </Toolbar>

      <p className="m-0 mb-3 text-sm text-muted" aria-live="polite">
        {list.isFetching && !list.data ? 'Loading customers…' : list.data ? `Showing ${rows.length} of ${pluralize(total, 'customer')}` : ''}
      </p>

      {list.error ? (
        <Alert>{errorMessage(list.error)}</Alert>
      ) : list.isLoading ? (
        <PageSpinner label="Loading customers" />
      ) : (
        <>
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(c) => c.id}
            caption="Customers"
            onRowClick={(c) => navigate(`/admin/customers/${c.id}`)}
            mobileTitle={(c) => <CustomerName customer={c} />}
            empty={
              q ? (
                <EmptyState title={`No customers match “${q}”`}>Check the spelling, or search by the last digits of the mobile number.</EmptyState>
              ) : (
                <EmptyState title="No customers yet">Customers are added when a booking request comes in or staff create a booking.</EmptyState>
              )
            }
          />
          {rows.length < total && (
            <div className="mt-4 flex justify-center">
              <Button variant="secondary" onClick={() => setLimit((l) => l + PAGE)} loading={list.isFetching}>
                Show more
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}

function CustomerName({ customer: c }: { customer: Customer }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Link
        to={`/admin/customers/${c.id}`}
        onClick={(e) => e.stopPropagation()}
        className="inline-flex min-h-11 items-center font-semibold text-ink md:min-h-0"
      >
        {c.full_name}
      </Link>
      {c.erased_at && <Badge tone="grey">Erased</Badge>}
      {c.blocked && <Badge tone="red">Blocked</Badge>}
    </span>
  );
}

const LICENCE_BADGE: Record<DocStatus, { tone: 'green' | 'amber' | 'red' | 'grey'; label: string }> = {
  verified: { tone: 'green', label: 'Licence verified' },
  pending: { tone: 'amber', label: 'Licence to check' },
  rejected: { tone: 'red', label: 'Licence rejected' },
  expired: { tone: 'red', label: 'Licence expired' },
  superseded: { tone: 'grey', label: 'No licence' },
};

function VerificationBadges({ customer, licence }: { customer: Customer; licence: DocStatus | null }) {
  const dl = licence ? LICENCE_BADGE[licence] : { tone: 'grey' as const, label: 'No licence uploaded' };
  return (
    <span className="inline-flex flex-wrap justify-end gap-1 md:justify-start">
      {customer.identity_verified ? <Badge tone="green">ID verified</Badge> : <Badge tone="outline">ID not verified</Badge>}
      <Badge tone={dl.tone}>{dl.label}</Badge>
    </span>
  );
}
