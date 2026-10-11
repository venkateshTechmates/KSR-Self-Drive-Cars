// Privacy requests (DP-04, DP-05): log every request about personal data and answer it by the due date.
// Export and erasure themselves happen on the customer page.
import { useState } from 'react';
import { Link } from 'react-router';
import { ArrowRight, Plus } from 'lucide-react';
import { DATA_REQUEST_LABELS } from '@shared/constants.ts';
import { formatPhone } from '@shared/validation.ts';
import { Badge } from '@/components/ui/Badges';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Field';
import { Chip, EmptyState, KeyValue, PageHeader, Toolbar } from '@/components/ui/Layout';
import { PageSpinner } from '@/components/ui/Spinner';
import { cn } from '@/lib/cn';
import { errorMessage } from '@/lib/errors';
import { formatDate, pluralize } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { useStaffName } from '../../hooks/queries';
import { NewRequestDialog, UpdateRequestDialog } from './RequestDialogs';
import {
  daysLeft,
  isOpen,
  isOverdue,
  KIND_NEXT_STEP,
  REQUEST_STATUS_LABELS,
  REQUEST_STATUS_TONES,
  useDataRequests,
  type RequestRow,
} from './requestData';

type View = 'open' | 'done' | 'refused' | 'all';

const VIEW_LABELS: Record<View, string> = { open: 'Open', done: 'Done', refused: 'Refused', all: 'All' };

const inView = (r: RequestRow, view: View) => (view === 'all' ? true : view === 'open' ? isOpen(r) : r.status === view);

/** Open requests by due date (soonest first), others newest first. */
function byUrgency(a: RequestRow, b: RequestRow) {
  if (isOpen(a) !== isOpen(b)) return isOpen(a) ? -1 : 1;
  if (isOpen(a)) {
    if (a.due_at !== b.due_at) return !a.due_at ? 1 : !b.due_at ? -1 : a.due_at.localeCompare(b.due_at);
    return a.received_at.localeCompare(b.received_at);
  }
  return b.received_at.localeCompare(a.received_at);
}

export default function DataRequestsPage() {
  const now = useNow();
  const requests = useDataRequests();
  const [view, setView] = useState<View>('open');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<RequestRow | null>(null);

  const all = requests.data ?? [];
  const shown = all.filter((r) => inView(r, view)).toSorted(byUrgency);
  const overdue = all.filter((r) => isOverdue(r, now));

  return (
    <>
      <PageHeader
        title="Privacy requests"
        description="Requests from customers to see, correct or erase their data, withdraw consent, or raise a grievance."
        actions={
          <Button icon={<Plus size={18} aria-hidden="true" />} onClick={() => setCreating(true)}>
            Log request
          </Button>
        }
      />

      {overdue.length > 0 && (
        <Alert className="mb-4" title={`${pluralize(overdue.length, 'request')} overdue`}>
          Answer these first, or record why they were refused.
        </Alert>
      )}

      <Toolbar>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Show requests">
          {(Object.keys(VIEW_LABELS) as View[]).map((v) => (
            <Chip key={v} pressed={view === v} onClick={() => setView(v)} count={all.filter((r) => inView(r, v)).length}>
              {VIEW_LABELS[v]}
            </Chip>
          ))}
        </div>
      </Toolbar>

      <p className="m-0 mb-3 text-sm text-muted" aria-live="polite">
        {requests.data ? `${pluralize(shown.length, 'request')} shown` : ''}
      </p>

      {requests.error ? (
        <Alert>{errorMessage(requests.error)}</Alert>
      ) : requests.isLoading ? (
        <PageSpinner label="Loading requests" />
      ) : shown.length === 0 ? (
        <EmptyState
          title={view === 'open' ? 'No open requests' : 'No requests here'}
          action={
            <Button variant="secondary" onClick={() => setCreating(true)}>
              Log request
            </Button>
          }
        >
          When a customer asks to see, correct or erase their data, log it here so it is answered in time.
        </EmptyState>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {shown.map((r) => (
            <RequestCard key={r.id} request={r} now={now} onUpdate={() => setEditing(r)} />
          ))}
        </ul>
      )}

      <NewRequestDialog open={creating} onClose={() => setCreating(false)} />
      <UpdateRequestDialog request={editing} onClose={() => setEditing(null)} />
    </>
  );
}

function RequestCard({ request: r, now, onUpdate }: { request: RequestRow; now: number; onUpdate: () => void }) {
  const staffName = useStaffName();
  const overdue = isOverdue(r, now);
  const left = daysLeft(r, now);
  const dueSoon = isOpen(r) && !overdue && left !== null && left <= 7;
  const contact = r.requester_contact.startsWith('+91') ? formatPhone(r.requester_contact) : r.requester_contact;

  return (
    <li className={cn('rounded-2xl border bg-surface p-4 sm:p-5', overdue ? 'border-danger ring-1 ring-danger' : 'border-line-card')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="m-0 text-[17px] font-bold">
            {DATA_REQUEST_LABELS[r.kind]}
            <span className="font-normal text-muted"> · {r.requester_name}</span>
          </h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge tone={REQUEST_STATUS_TONES[r.status]}>{REQUEST_STATUS_LABELS[r.status]}</Badge>
            {overdue && <Badge tone="red">Overdue{left !== null && left < 0 ? ` by ${pluralize(-left, 'day')}` : ''}</Badge>}
            {dueSoon && <Badge tone="amber">{left === 0 ? 'Due today' : `Due in ${pluralize(left!, 'day')}`}</Badge>}
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={onUpdate}>
          Update<span className="sr-only">: {DATA_REQUEST_LABELS[r.kind]} from {r.requester_name}</span>
        </Button>
      </div>

      <KeyValue
        className="mt-4 lg:grid-cols-4"
        items={[
          ['Contact', contact],
          ['Received', formatDate(r.received_at)],
          ['Answer by', r.due_at ? <span className={cn(overdue && 'text-danger')}>{formatDate(r.due_at)}</span> : 'Not set'],
          [
            'Customer',
            r.customer ? (
              <Link to={`/admin/customers/${r.customer.id}`} className="text-ink">
                {r.customer.full_name}
              </Link>
            ) : (
              <span className="font-normal text-muted">Not linked</span>
            ),
          ],
          r.handled_by ? ['Handled by', staffName(r.handled_by)] : null,
          r.resolved_at ? ['Closed on', formatDate(r.resolved_at)] : null,
        ]}
      />

      {r.details && (
        <div className="mt-3">
          <p className="m-0 text-sm text-muted">Details</p>
          <p className="m-0 whitespace-pre-wrap">{r.details}</p>
        </div>
      )}
      {r.resolution && (
        <div className="mt-3">
          <p className="m-0 text-sm text-muted">Resolution</p>
          <p className="m-0 whitespace-pre-wrap">{r.resolution}</p>
        </div>
      )}

      {isOpen(r) && (
        <div className="mt-4 flex flex-col gap-2 border-t border-line-card pt-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="m-0 text-sm text-ink-2">
            {r.customer ? KIND_NEXT_STEP[r.kind] : 'Link the customer record (Update) to act on their data.'}
          </p>
          {r.customer && !r.customer.erased_at && (
            <ButtonLink
              to={`/admin/customers/${r.customer.id}`}
              variant="ghost"
              size="sm"
              icon={<ArrowRight size={16} aria-hidden="true" />}
              className="self-start sm:self-auto"
            >
              Open customer
            </ButtonLink>
          )}
        </div>
      )}
    </li>
  );
}
