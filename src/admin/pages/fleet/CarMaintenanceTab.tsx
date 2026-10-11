// Maintenance tab (FLT-04, FLT-06): windows when the car is shown but not bookable.
// Clashing bookings are listed before saving.
import { useState } from 'react';
import { Link } from 'react-router';
import { Pencil, Plus, Trash2, Wrench } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { MAINTENANCE_REASON_LABELS, MAINTENANCE_REASONS, type BookingStatus, type MaintenanceReason } from '@shared/constants.ts';
import { IST_OFFSET_MINUTES, MS_DAY, MS_HOUR, MS_MINUTE, formatWhen, fromIstLocalInput, toIstLocalInput } from '@shared/time.ts';
import { Badge, StatusPill } from '@/components/ui/Badges';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog, Dialog, DialogFooter } from '@/components/ui/Dialog';
import { Alert, Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Card, CardBody, CardHeader, EmptyState } from '@/components/ui/Layout';
import { Spinner } from '@/components/ui/Spinner';
import { api } from '@/integrations/api/client';
import { errorMessage, unwrap } from '@/lib/errors';
import { formatDuration } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import type { Car, Clash, MaintenanceWindow } from '@/types/db';
import { useAuth } from '../../auth/AuthProvider';
import { qk, useStaffName } from '../../hooks/queries';
import { useMaintenanceWindows } from './fleetData';

type Phase = 'now' | 'upcoming' | 'past';

const phaseOf = (w: MaintenanceWindow, now: number): Phase => {
  const s = Date.parse(w.starts_at);
  const e = Date.parse(w.ends_at);
  if (s <= now && now < e) return 'now';
  return s > now ? 'upcoming' : 'past';
};

export function CarMaintenanceTab({ car }: { car: Car }) {
  const queryClient = useQueryClient();
  const now = useNow();
  const windows = useMaintenanceWindows(car.id);
  const staffName = useStaffName();
  const [editing, setEditing] = useState<MaintenanceWindow | 'new' | null>(null);
  const [deleting, setDeleting] = useState<MaintenanceWindow | null>(null);
  const [busy, setBusy] = useState(false);

  const list = windows.data ?? [];
  const groups: Array<{ phase: Phase; title: string; items: MaintenanceWindow[] }> = [
    { phase: 'now', title: 'Now', items: list.filter((w) => phaseOf(w, now) === 'now') },
    {
      phase: 'upcoming',
      title: 'Upcoming',
      items: list.filter((w) => phaseOf(w, now) === 'upcoming').sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
    },
    { phase: 'past', title: 'Past', items: list.filter((w) => phaseOf(w, now) === 'past') },
  ];

  async function remove(w: MaintenanceWindow) {
    unwrap(await api.from('maintenance_windows').delete().eq('id', w.id).select('id'));
    await queryClient.invalidateQueries({ queryKey: qk.cars });
    toast.success('Maintenance removed');
  }

  return (
    <Card>
      <CardHeader
        title="Maintenance"
        description="During a maintenance window the car stays on the website but can't be booked."
        actions={
          <Button size="sm" icon={<Plus size={18} aria-hidden="true" />} onClick={() => setEditing('new')}>
            Add maintenance
          </Button>
        }
      />
      <CardBody className="flex flex-col gap-5">
        {windows.isLoading ? (
          <div className="flex justify-center p-6">
            <Spinner label="Loading maintenance" />
          </div>
        ) : windows.error ? (
          <Alert title="Couldn't load maintenance">{errorMessage(windows.error)}</Alert>
        ) : list.length === 0 ? (
          <EmptyState title="No maintenance planned">Add a window for a service, repair or accident so the car can't be booked then.</EmptyState>
        ) : (
          groups
            .filter((g) => g.items.length)
            .map((g) => (
              <section key={g.phase} className="flex flex-col gap-2">
                <h3 className="m-0 text-[15px] font-bold text-muted">{g.title}</h3>
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {g.items.map((w) => (
                    <li key={w.id} className="flex flex-col gap-3 rounded-xl border border-line-card p-3 sm:flex-row sm:items-start">
                      <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-lg bg-tile text-ink-2" aria-hidden="true">
                        <Wrench size={20} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="m-0 flex flex-wrap items-center gap-2 font-semibold">
                          {MAINTENANCE_REASON_LABELS[w.reason]}
                          {g.phase === 'now' && <Badge tone="amber">In maintenance now</Badge>}
                          {g.phase === 'upcoming' && <Badge tone="blue">Upcoming</Badge>}
                        </p>
                        <p className="m-0 text-[15px]">
                          {formatWhen(w.starts_at)} to {formatWhen(w.ends_at)}{' '}
                          <span className="text-muted">({formatDuration(Date.parse(w.ends_at) - Date.parse(w.starts_at))})</span>
                        </p>
                        {w.notes && <p className="m-0 mt-1 text-[15px] break-words text-ink-2">{w.notes}</p>}
                        <p className="m-0 mt-1 text-sm text-muted">Added by {staffName(w.created_by)}</p>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        <Button variant="ghost" size="sm" icon={<Pencil size={16} aria-hidden="true" />} onClick={() => setEditing(w)}>
                          Edit
                        </Button>
                        <Button variant="ghost" size="sm" icon={<Trash2 size={16} aria-hidden="true" />} onClick={() => setDeleting(w)}>
                          Delete
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))
        )}
      </CardBody>

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        locked={busy}
        title={editing === 'new' ? 'Add maintenance' : 'Edit maintenance'}
        description="Times are India time (IST)."
      >
        {editing !== null && (
          <MaintenanceForm
            key={editing === 'new' ? 'new' : editing.id}
            car={car}
            existing={editing === 'new' ? null : editing}
            now={now}
            setBusy={setBusy}
            onClose={() => setEditing(null)}
          />
        )}
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title="Delete this maintenance window?"
        description="The car can be booked in this time again."
        confirmLabel="Delete"
        tone="danger"
        onConfirm={() => remove(deleting!)}
      />
    </Card>
  );
}

interface Overlap {
  id: string;
  code: string;
  status: BookingStatus;
  starts_at: string;
  ends_at: string;
}

/** Next full hour in IST. */
function nextIstHour(now: number): number {
  const off = IST_OFFSET_MINUTES * MS_MINUTE;
  return Math.ceil((now + off) / MS_HOUR) * MS_HOUR - off;
}

function MaintenanceForm({
  car,
  existing,
  now,
  setBusy,
  onClose,
}: {
  car: Car;
  existing: MaintenanceWindow | null;
  now: number;
  setBusy: (b: boolean) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const [start, setStart] = useState(() => toIstLocalInput(existing?.starts_at ?? nextIstHour(now)));
  const [end, setEnd] = useState(() => toIstLocalInput(existing?.ends_at ?? nextIstHour(now) + MS_DAY));
  const [reason, setReason] = useState<MaintenanceReason>(existing?.reason ?? 'service');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [errors, setErrors] = useState<{ start?: string; end?: string; form?: string }>({});
  const [overlaps, setOverlaps] = useState<{ bookings: Overlap[]; maintenance: Clash[] } | null>(null);
  const [working, setWorking] = useState(false);

  function begin() {
    setWorking(true);
    setBusy(true);
  }
  function finish() {
    setWorking(false);
    setBusy(false);
  }

  function parse() {
    const s = fromIstLocalInput(start);
    const e = fromIstLocalInput(end);
    const next: typeof errors = {};
    if (!s) next.start = 'Enter the start date and time.';
    if (!e) next.end = 'Enter the end date and time.';
    if (s && e && e.getTime() <= s.getTime()) next.end = 'The end must be after the start.';
    setErrors(next);
    return next.start || next.end ? null : { s: s!, e: e! };
  }

  async function check() {
    const range = parse();
    if (!range) return;
    begin();
    try {
      const clashes = (unwrap(
        await api.rpc('car_clashes', { p_car: car.id, p_start: range.s.toISOString(), p_end: range.e.toISOString(), p_exclude: null }),
      ) ?? []) as Clash[];
      const requested = unwrap(
        await api
          .from('bookings')
          .select('id, booking_code, status, pickup_at, return_due_at')
          .eq('car_id', car.id)
          .eq('status', 'requested')
          .lt('pickup_at', range.e.toISOString())
          .gt('return_due_at', range.s.toISOString()),
      ) as Array<{ id: string; booking_code: string; status: BookingStatus; pickup_at: string; return_due_at: string }>;
      const bookings: Overlap[] = [
        ...clashes
          .filter((c) => c.kind === 'booking')
          .map((c) => ({ id: c.ref_id, code: c.booking_code ?? '', status: c.status ?? 'confirmed', starts_at: c.starts_at, ends_at: c.ends_at })),
        ...requested.map((b) => ({ id: b.id, code: b.booking_code, status: b.status, starts_at: b.pickup_at, ends_at: b.return_due_at })),
      ].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
      const maintenance = clashes.filter((c) => c.kind === 'maintenance' && c.ref_id !== existing?.id);
      if (bookings.length || maintenance.length) {
        setOverlaps({ bookings, maintenance });
        finish();
        return;
      }
      finish();
      await save();
    } catch (err) {
      setErrors({ form: errorMessage(err) });
      finish();
    }
  }

  async function save() {
    const range = parse();
    if (!range) return;
    begin();
    try {
      const row = { starts_at: range.s.toISOString(), ends_at: range.e.toISOString(), reason, notes: notes.trim() };
      if (existing) {
        unwrap(await api.from('maintenance_windows').update(row).eq('id', existing.id).select('id').single());
      } else {
        unwrap(
          await api
            .from('maintenance_windows')
            .insert({ ...row, car_id: car.id, created_by: session?.user.id ?? null })
            .select('id')
            .single(),
        );
      }
      await queryClient.invalidateQueries({ queryKey: qk.cars });
      toast.success(existing ? 'Maintenance saved' : 'Maintenance added');
      finish();
      onClose();
    } catch (err) {
      setErrors({ form: errorMessage(err) });
      finish();
    }
  }

  if (overlaps) {
    const n = overlaps.bookings.length;
    return (
      <>
        <div className="flex flex-col gap-4">
          {n > 0 && (
            <Alert tone="warning" title={`${n} ${n === 1 ? 'booking overlaps' : 'bookings overlap'} this window`}>
              Move the car or time on {n === 1 ? 'this booking' : 'these bookings'}, or save anyway. Bookings that are already confirmed keep the
              car until you change them.
            </Alert>
          )}
          {n > 0 && (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {overlaps.bookings.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-line-card p-3">
                  <Link to={`/admin/bookings/${b.code}`} target="_blank" rel="noopener" className="font-mono font-semibold">
                    {b.code}
                    <span className="sr-only"> (opens in a new tab)</span>
                  </Link>
                  <StatusPill status={b.status} />
                  <span className="text-[15px] text-muted">
                    {formatWhen(b.starts_at)} to {formatWhen(b.ends_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {overlaps.maintenance.length > 0 && (
            <Alert tone="info" title="Overlaps other maintenance">
              <ul className="m-0 pl-5">
                {overlaps.maintenance.map((m) => (
                  <li key={m.ref_id}>
                    {formatWhen(m.starts_at)} to {formatWhen(m.ends_at)}
                    {m.note ? ` (${m.note})` : ''}
                  </li>
                ))}
              </ul>
            </Alert>
          )}
          {errors.form && <Alert title="Couldn't save">{errors.form}</Alert>}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setOverlaps(null)} disabled={working}>
            Back
          </Button>
          <Button onClick={() => void save()} loading={working} loadingText="Saving…">
            Save anyway
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Start" required error={errors.start}>
            <Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="End" required error={errors.end}>
            <Input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        <Field label="Reason" required>
          <Select value={reason} onChange={(e) => setReason(e.target.value as MaintenanceReason)}>
            {MAINTENANCE_REASONS.map((r) => (
              <option key={r} value={r}>
                {MAINTENANCE_REASON_LABELS[r]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Notes" optional hint="For example the garage or the work planned.">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={1000} />
        </Field>
        {errors.form && <Alert title="Couldn't save">{errors.form}</Alert>}
      </div>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose} disabled={working}>
          Cancel
        </Button>
        <Button onClick={() => void check()} loading={working} loadingText="Checking…">
          Save
        </Button>
      </DialogFooter>
    </>
  );
}
