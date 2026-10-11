// /admin/audit (AUD-01..04, Owner only). Read-only, newest first, 100 entries at a time.
// Search by who, action, record and IST date range; expand an entry to see before/after values.
import { Fragment, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, Lock } from 'lucide-react';
import { APP_ROLES, ROLE_LABELS, type AppRole } from '@shared/constants.ts';
import { Button } from '@/components/ui/Button';
import { Alert, Field, Input, Select } from '@/components/ui/Field';
import { EmptyState, PageHeader, Toolbar } from '@/components/ui/Layout';
import { PageSpinner } from '@/components/ui/Spinner';
import { api } from '@/integrations/api/client';
import { cn } from '@/lib/cn';
import { errorMessage, unwrap } from '@/lib/errors';
import { formatDateTime, istDateIso } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import type { AuditLog } from '@/types/db';
import { qk, useSetting, useStaffDirectory, useStaffName } from '../../hooks/queries';
import { DateRangeFilter } from '../reports/DateRangeFilter';
import { describeRange, initialRange, rangeBounds, resolveRange, type RangeState } from '../reports/range';
import {
  ACTION_PREFIXES,
  diffRows,
  ENTITY_LABELS,
  entityLabel,
  likeEscape,
  recordLink,
  relatedBookingId,
  shortDevice,
  showValue,
  type RecordLink,
} from './auditUtils';

const PAGE_SIZE = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const roleLabel = (r: string | null) => (r && (APP_ROLES as readonly string[]).includes(r) ? ROLE_LABELS[r as AppRole] : null);
const shortId = (id: string | null) => (id ? (UUID_RE.test(id) ? id.slice(0, 8) : id) : '');

interface Filters {
  actor: string;
  prefix: string;
  actionText: string;
  entityType: string;
  entityId: string;
}

const NO_FILTERS: Filters = { actor: '', prefix: '', actionText: '', entityType: '', entityId: '' };

export default function AuditLogPage() {
  const now = useNow();
  const today = istDateIso(now);
  const staffName = useStaffName();
  const { data: staff = [] } = useStaffDirectory();
  const retention = useSetting('retention');

  const [rangeState, setRangeState] = useState<RangeState>(() => initialRange('all'));
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  // Text boxes apply on "Search" so each keystroke doesn't query the log.
  const [actionDraft, setActionDraft] = useState('');
  const [idDraft, setIdDraft] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const { range, error: rangeError } = resolveRange(rangeState, today);
  const bounds = range ? rangeBounds(range) : null;
  const rangeValid = !rangeError;

  const log = useInfiniteQuery({
    queryKey: [...qk.audit, filters, bounds?.fromTs ?? null, bounds?.toTs ?? null],
    enabled: rangeValid,
    initialPageParam: 0,
    placeholderData: keepPreviousData,
    queryFn: async ({ pageParam }) => {
      let q = api.from('audit_logs').select('*');
      if (filters.actor === 'system') q = q.is('actor_id', null);
      else if (filters.actor) q = q.eq('actor_id', filters.actor);
      if (filters.prefix) q = q.like('action', `${likeEscape(filters.prefix)}%`);
      if (filters.actionText) q = q.ilike('action', `%${likeEscape(filters.actionText)}%`);
      if (filters.entityType) q = q.eq('entity_type', filters.entityType);
      if (filters.entityId) q = q.ilike('entity_id', `%${likeEscape(filters.entityId)}%`);
      if (bounds) q = q.gte('at', bounds.fromTs).lt('at', bounds.toTs);
      const from = pageParam * PAGE_SIZE;
      return unwrap(await q.order('at', { ascending: false }).order('id', { ascending: false }).range(from, from + PAGE_SIZE - 1)) as AuditLog[];
    },
    getNextPageParam: (last, all) => (last.length === PAGE_SIZE ? all.length : undefined),
  });

  const entries = log.data?.pages.flat() ?? [];

  // Booking entries store the booking's UUID; look up codes so they can link to the booking.
  const bookingIds = [...new Set(entries.map(relatedBookingId).filter((id): id is string => Boolean(id && UUID_RE.test(id))))].sort();
  const codes = useQuery({
    queryKey: [...qk.bookings, 'codes', bookingIds],
    enabled: bookingIds.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const map: Record<string, string> = {};
      for (let i = 0; i < bookingIds.length; i += 100) {
        const rows = unwrap(await api.from('bookings').select('id, booking_code').in('id', bookingIds.slice(i, i + 100))) as Array<{
          id: string;
          booking_code: string;
        }>;
        for (const r of rows) map[r.id] = r.booking_code;
      }
      return map;
    },
  });
  const bookingCode = (id: string) => codes.data?.[id];

  const filtersActive = Object.values(filters).some(Boolean) || rangeState.preset !== 'all';

  function search(e: FormEvent) {
    e.preventDefault();
    setFilters((f) => ({ ...f, actionText: actionDraft.trim(), entityId: idDraft.trim() }));
  }

  function clearAll() {
    setFilters(NO_FILTERS);
    setActionDraft('');
    setIdDraft('');
    setRangeState(initialRange('all'));
  }

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const who = (e: AuditLog) => (
    <>
      <span className="font-semibold">{staffName(e.actor_id)}</span>
      {roleLabel(e.actor_role) && <span className="block text-sm text-muted">{roleLabel(e.actor_role)}</span>}
    </>
  );

  const record = (e: AuditLog) => {
    const link: RecordLink | null = recordLink(e, bookingCode);
    return (
      <>
        <span>{entityLabel(e.entity_type)}</span>
        {link && (
          <Link to={link.to} className="block font-semibold break-all">
            {link.label}
          </Link>
        )}
        {e.entity_id && (!link || link.label !== e.entity_id) && (
          <span className="block font-mono text-[13px] break-all text-muted" title={e.entity_id}>
            {shortId(e.entity_id)}
          </span>
        )}
      </>
    );
  };

  const device = (e: AuditLog) => <span title={e.user_agent ?? undefined}>{shortDevice(e.user_agent)}</span>;

  const detailsButton = (e: AuditLog) => {
    const open = expanded.has(e.id);
    return (
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-controls={`audit-detail-${e.id}`}
        onClick={() => toggle(e.id)}
        icon={open ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
      >
        {open ? 'Hide' : 'Details'}
      </Button>
    );
  };

  return (
    <>
      <PageHeader title="Audit log" description="Who did what, to which record, and when. Times are in IST." />

      <Alert tone="info" className="mb-4">
        <span className="inline-flex items-start gap-2">
          <Lock size={16} aria-hidden="true" className="mt-1 shrink-0" />
          <span>
            Entries are read-only: nobody can edit or delete them from the app. They're kept for at least{' '}
            {retention.data ? `${retention.data.audit_days} days` : 'the audit retention period'}, and never less than the longest document
            retention.
          </span>
        </span>
      </Alert>

      <form onSubmit={search} aria-label="Search the audit log">
        <Toolbar>
          <Field label="Who" className="w-full sm:w-52">
            <Select value={filters.actor} onChange={(e) => setFilters((f) => ({ ...f, actor: e.target.value }))}>
              <option value="">Anyone</option>
              <option value="system">System (automatic jobs)</option>
              {staff.map((s) => (
                <option key={s.user_id} value={s.user_id}>
                  {s.full_name}
                  {s.active ? '' : ' (inactive)'}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Action type" className="w-full sm:w-64">
            <Select value={filters.prefix} onChange={(e) => setFilters((f) => ({ ...f, prefix: e.target.value }))}>
              <option value="">Any action</option>
              {ACTION_PREFIXES.map(([p, label]) => (
                <option key={p} value={p}>
                  {label} ({p}…)
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Action contains" className="w-full sm:w-48">
            <Input value={actionDraft} onChange={(e) => setActionDraft(e.target.value)} placeholder="e.g. export" />
          </Field>
          <Field label="Record type" className="w-[calc(50%-0.375rem)] sm:w-44">
            <Select value={filters.entityType} onChange={(e) => setFilters((f) => ({ ...f, entityType: e.target.value }))}>
              <option value="">Any record</option>
              {Object.entries(ENTITY_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Record ID contains" className="w-[calc(50%-0.375rem)] sm:w-48">
            <Input value={idDraft} onChange={(e) => setIdDraft(e.target.value)} autoComplete="off" spellCheck={false} />
          </Field>
          <DateRangeFilter value={rangeState} onChange={setRangeState} today={today} allowAll />
          <div className="flex gap-2">
            <Button type="submit">Search</Button>
            {(filtersActive || actionDraft || idDraft) && (
              <Button variant="ghost" onClick={clearAll}>
                Clear
              </Button>
            )}
          </div>
        </Toolbar>
      </form>

      {!rangeValid ? (
        <Alert tone="info">{rangeError}</Alert>
      ) : log.error ? (
        <Alert tone="error" title="Couldn't load the audit log">
          {errorMessage(log.error)} Reload the page to try again.
        </Alert>
      ) : !log.data ? (
        <PageSpinner label="Loading the audit log" />
      ) : entries.length === 0 ? (
        <EmptyState title="No entries match">{filtersActive ? 'Try fewer filters or a wider date range.' : 'Nothing has been recorded yet.'}</EmptyState>
      ) : (
        <div className={cn('flex flex-col gap-4 transition-opacity', log.isPlaceholderData && 'opacity-60')}>
          <p className="m-0 text-[15px] text-muted" aria-live="polite">
            {entries.length} {entries.length === 1 ? 'entry' : 'entries'}, newest first{log.hasNextPage ? ' (more below)' : ''} ·{' '}
            {describeRange(range)}
          </p>

          {/* Wide screens: table with expandable rows */}
          <div className="hidden overflow-x-auto rounded-2xl border border-line-card bg-surface md:block">
            <table className="w-full border-collapse text-left text-[15px]">
              <caption className="sr-only">Audit log entries, newest first</caption>
              <thead>
                <tr className="border-b border-line-card bg-subtle">
                  {['When', 'Who', 'Action', 'Record', 'IP address', 'Device', 'Details'].map((h) => (
                    <th key={h} scope="col" className="px-3 py-2.5 text-[13px] font-semibold whitespace-nowrap text-muted">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <Fragment key={e.id}>
                    <tr className={cn('border-b border-line-card align-top', expanded.has(e.id) && 'bg-subtle')}>
                      <td className="px-3 py-2.5 whitespace-nowrap">{formatDateTime(e.at)}</td>
                      <td className="px-3 py-2.5">{who(e)}</td>
                      <td className="px-3 py-2.5">
                        <code className="font-mono text-[14px] break-all">{e.action}</code>
                      </td>
                      <td className="max-w-56 px-3 py-2.5">{record(e)}</td>
                      <td className="px-3 py-2.5 font-mono text-[13px] break-all">{e.ip ?? '—'}</td>
                      <td className="px-3 py-2.5">{device(e)}</td>
                      <td className="px-2 py-1">{detailsButton(e)}</td>
                    </tr>
                    {expanded.has(e.id) && (
                      <tr className="border-b border-line-card bg-subtle">
                        <td colSpan={7} className="px-3 pb-4" id={`audit-detail-${e.id}`}>
                          <DiffView entry={e} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>

          {/* Phones: cards */}
          <ul className="m-0 flex list-none flex-col gap-3 p-0 md:hidden">
            {entries.map((e) => (
              <li key={e.id} className="rounded-2xl border border-line-card bg-surface p-4">
                <div className="flex items-start justify-between gap-2">
                  <code className="font-mono text-[14px] font-semibold break-all">{e.action}</code>
                  <span className="shrink-0 text-sm text-muted">{formatDateTime(e.at)}</span>
                </div>
                <dl className="m-0 mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[15px]">
                  <dt className="text-muted">Who</dt>
                  <dd className="m-0 min-w-0">{who(e)}</dd>
                  <dt className="text-muted">Record</dt>
                  <dd className="m-0 min-w-0">{record(e)}</dd>
                  <dt className="text-muted">IP</dt>
                  <dd className="m-0 min-w-0 font-mono text-[13px] break-all">{e.ip ?? '—'}</dd>
                  <dt className="text-muted">Device</dt>
                  <dd className="m-0 min-w-0">{device(e)}</dd>
                </dl>
                <div className="mt-2">{detailsButton(e)}</div>
                {expanded.has(e.id) && (
                  <div id={`audit-detail-${e.id}`} className="mt-2">
                    <DiffView entry={e} />
                  </div>
                )}
              </li>
            ))}
          </ul>

          {log.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="secondary" onClick={() => void log.fetchNextPage()} loading={log.isFetchingNextPage} loadingText="Loading…">
                Show {PAGE_SIZE} more
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function DiffView({ entry }: { entry: AuditLog }) {
  const rows = diffRows(entry.before, entry.after);
  if (!entry.before && !entry.after) return <p className="m-0 pt-2 text-[15px] text-muted">No other details were recorded for this entry.</p>;
  if (rows.length === 0) return <p className="m-0 pt-2 text-[15px] text-muted">No field values changed.</p>;
  const both = Boolean(entry.before && entry.after);
  const caption = both ? 'Changed fields, before and after' : entry.after ? 'Recorded values' : 'Values before removal';
  return (
    <div className="flex flex-col gap-2 pt-2">
      <p className="m-0 text-sm font-semibold text-ink-2">{caption}</p>
      <div className="overflow-x-auto rounded-xl border border-line-card bg-surface">
        <table className="w-full border-collapse text-left text-[14px]">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-line-card bg-subtle">
              <th scope="col" className="px-3 py-2 text-[13px] font-semibold text-muted">
                Field
              </th>
              {both ? (
                <>
                  <th scope="col" className="px-3 py-2 text-[13px] font-semibold text-muted">
                    Before
                  </th>
                  <th scope="col" className="px-3 py-2 text-[13px] font-semibold text-muted">
                    After
                  </th>
                </>
              ) : (
                <th scope="col" className="px-3 py-2 text-[13px] font-semibold text-muted">
                  Value
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-b border-line-card align-top last:border-0">
                <th scope="row" className="px-3 py-2 font-mono text-[13px] font-semibold break-all">
                  {r.key}
                </th>
                {both ? (
                  <>
                    <td className="px-3 py-2 break-words whitespace-pre-wrap text-ink-3">{showValue(r.before)}</td>
                    <td className="px-3 py-2 font-semibold break-words whitespace-pre-wrap">{showValue(r.after)}</td>
                  </>
                ) : (
                  <td className="px-3 py-2 break-words whitespace-pre-wrap">{showValue(entry.after ? r.after : r.before)}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
