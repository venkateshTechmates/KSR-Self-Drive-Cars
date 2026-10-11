// Service log tab (FLT-09): date, odometer, work done, cost, garage and an invoice document
// uploaded through the document centre (type service_invoice) and linked to the row.
import { useState } from 'react';
import { FileText, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { formatIsoDate } from '@shared/time.ts';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog, Dialog, DialogFooter } from '@/components/ui/Dialog';
import { Alert, Field, Input, Textarea } from '@/components/ui/Field';
import { Card, CardBody, CardHeader, DataTable, EmptyState, type Column } from '@/components/ui/Layout';
import { Spinner } from '@/components/ui/Spinner';
import { api } from '@/integrations/api/client';
import { errorMessage, unwrap } from '@/lib/errors';
import { formatRupees, istDateIso, paiseToInput, parseRupees } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import type { Car, DocumentRow, ServiceLog } from '@/types/db';
import { useAuth } from '../../auth/AuthProvider';
import { DocumentUploadDialog } from '../../components/documents/DocumentUploadDialog';
import { DocumentViewer } from '../../components/documents/DocumentViewer';
import { useOwnerDocuments } from '../../components/documents/DocumentsPanel';
import { qk } from '../../hooks/queries';
import { useServiceLogs } from './fleetData';

const km = new Intl.NumberFormat('en-IN');

export function CarServiceLogTab({ car }: { car: Car }) {
  const queryClient = useQueryClient();
  const now = useNow();
  const logs = useServiceLogs(car.id);
  const docs = useOwnerDocuments('car', car.id);
  const [editing, setEditing] = useState<ServiceLog | 'new' | null>(null);
  const [deleting, setDeleting] = useState<ServiceLog | null>(null);
  const [invoiceFor, setInvoiceFor] = useState<ServiceLog | null>(null);
  const [viewing, setViewing] = useState<DocumentRow | null>(null);
  const [busy, setBusy] = useState(false);

  const list = logs.data ?? [];
  const total = list.reduce((sum, l) => sum + l.cost_paise, 0);

  async function linkInvoice(logId: string, doc: DocumentRow | undefined) {
    if (!doc) return;
    try {
      unwrap(await api.from('service_logs').update({ invoice_document_id: doc.id }).eq('id', logId).select('id').single());
      await queryClient.invalidateQueries({ queryKey: qk.car(car.id) });
      toast.success('Invoice added to the service');
    } catch (err) {
      toast.error(`The invoice was uploaded but not linked to the service. ${errorMessage(err)}`);
    }
  }

  async function remove(log: ServiceLog) {
    unwrap(await api.from('service_logs').delete().eq('id', log.id).select('id'));
    await queryClient.invalidateQueries({ queryKey: qk.car(car.id) });
    toast.success('Service removed');
  }

  const invoiceCell = (log: ServiceLog) => {
    if (!log.invoice_document_id) {
      return (
        <Button variant="ghost" size="sm" icon={<Upload size={16} aria-hidden="true" />} onClick={() => setInvoiceFor(log)}>
          Add invoice
        </Button>
      );
    }
    const doc = docs.data?.find((d) => d.id === log.invoice_document_id);
    if (!doc) return docs.isLoading ? <Spinner size={16} label="Loading" /> : <span className="text-muted">Invoice removed</span>;
    return (
      <Button variant="ghost" size="sm" icon={<FileText size={16} aria-hidden="true" />} onClick={() => setViewing(doc)}>
        View invoice
      </Button>
    );
  };

  const columns: Column<ServiceLog>[] = [
    { key: 'date', header: 'Date', cell: (l) => formatIsoDate(l.service_date), className: 'whitespace-nowrap', hideOnMobile: true },
    { key: 'odo', header: 'Odometer', cell: (l) => (l.odometer_km === null ? '—' : `${km.format(l.odometer_km)} km`), className: 'whitespace-nowrap' },
    { key: 'work', header: 'Work done', cell: (l) => <span className="break-words whitespace-pre-line">{l.work_done}</span>, hideOnMobile: true },
    { key: 'garage', header: 'Garage', cell: (l) => l.garage || '—' },
    { key: 'cost', header: 'Cost', cell: (l) => formatRupees(l.cost_paise), className: 'whitespace-nowrap' },
    { key: 'invoice', header: 'Invoice', cell: invoiceCell },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      cell: (l) => (
        <span className="inline-flex flex-wrap justify-end gap-1">
          <Button variant="ghost" size="sm" icon={<Pencil size={16} aria-hidden="true" />} onClick={() => setEditing(l)}>
            Edit
          </Button>
          <Button variant="ghost" size="sm" icon={<Trash2 size={16} aria-hidden="true" />} onClick={() => setDeleting(l)}>
            Delete
          </Button>
        </span>
      ),
    },
  ];

  return (
    <Card>
      <CardHeader
        title="Service log"
        description={list.length ? `${list.length} ${list.length === 1 ? 'entry' : 'entries'} · ${formatRupees(total)} spent in total` : undefined}
        actions={
          <Button size="sm" icon={<Plus size={18} aria-hidden="true" />} onClick={() => setEditing('new')}>
            Add service
          </Button>
        }
      />
      <CardBody>
        {logs.isLoading ? (
          <div className="flex justify-center p-6">
            <Spinner label="Loading service log" />
          </div>
        ) : logs.error ? (
          <Alert title="Couldn't load the service log">{errorMessage(logs.error)}</Alert>
        ) : (
          <DataTable
            rows={list}
            columns={columns}
            rowKey={(l) => l.id}
            caption="Service log, latest first"
            mobileTitle={(l) => (
              <span className="flex flex-col">
                <span className="font-semibold">{formatIsoDate(l.service_date)}</span>
                <span className="break-words whitespace-pre-line">{l.work_done}</span>
              </span>
            )}
            empty={<EmptyState title="No services logged yet">Add each service or repair with its cost and invoice.</EmptyState>}
          />
        )}
      </CardBody>

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        locked={busy}
        title={editing === 'new' ? 'Add service' : 'Edit service'}
        description="Add the invoice from the list after saving."
      >
        {editing !== null && (
          <ServiceForm
            key={editing === 'new' ? 'new' : editing.id}
            car={car}
            existing={editing === 'new' ? null : editing}
            todayIso={istDateIso(now)}
            setBusy={setBusy}
            onClose={() => setEditing(null)}
          />
        )}
      </Dialog>

      <DocumentUploadDialog
        open={Boolean(invoiceFor)}
        onClose={() => setInvoiceFor(null)}
        ownerType="car"
        ownerId={car.id}
        allowedTypes={['service_invoice']}
        defaultType="service_invoice"
        onUploaded={(uploaded) => {
          if (invoiceFor) void linkInvoice(invoiceFor.id, uploaded[0]);
        }}
      />
      <DocumentViewer doc={viewing} open={Boolean(viewing)} onClose={() => setViewing(null)} />
      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title="Delete this service entry?"
        description="Its invoice stays in Papers."
        confirmLabel="Delete"
        tone="danger"
        onConfirm={() => remove(deleting!)}
      />
    </Card>
  );
}

function ServiceForm({
  car,
  existing,
  todayIso,
  setBusy,
  onClose,
}: {
  car: Car;
  existing: ServiceLog | null;
  todayIso: string;
  setBusy: (b: boolean) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const [date, setDate] = useState(existing?.service_date ?? todayIso);
  const [odometer, setOdometer] = useState(existing?.odometer_km != null ? String(existing.odometer_km) : '');
  const [work, setWork] = useState(existing?.work_done ?? '');
  const [cost, setCost] = useState(existing ? paiseToInput(existing.cost_paise) : '');
  const [garage, setGarage] = useState(existing?.garage ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  async function save() {
    const e: Record<string, string> = {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) e.date = 'Enter the service date.';
    else if (date > todayIso) e.date = 'Choose today or an earlier date. Plan future work as maintenance.';
    const odo = odometer.trim().replace(/[,\s]/g, '');
    if (odo && (!/^\d+$/.test(odo) || Number(odo) > 2_000_000)) e.odometer = 'Enter the odometer reading in whole kilometres, for example 45210.';
    if (!work.trim()) e.work = 'Describe the work done, for example "Oil change and brake pads".';
    else if (work.trim().length > 1000) e.work = 'Keep this to 1,000 characters or fewer.';
    const costPaise = cost.trim() ? parseRupees(cost) : 0;
    if (costPaise === null) e.cost = 'Enter the cost in rupees, for example 3500.';
    setErrors(e);
    if (Object.keys(e).length) return;

    setSaving(true);
    setBusy(true);
    try {
      const row = {
        service_date: date,
        odometer_km: odo ? Number(odo) : null,
        work_done: work.trim(),
        cost_paise: costPaise,
        garage: garage.trim(),
      };
      if (existing) {
        unwrap(await api.from('service_logs').update(row).eq('id', existing.id).select('id').single());
      } else {
        unwrap(
          await api
            .from('service_logs')
            .insert({ ...row, car_id: car.id, created_by: session?.user.id ?? null })
            .select('id')
            .single(),
        );
      }
      await queryClient.invalidateQueries({ queryKey: qk.car(car.id) });
      toast.success(existing ? 'Service saved' : 'Service added');
      onClose();
    } catch (err) {
      setErrors({ form: errorMessage(err) });
    } finally {
      setSaving(false);
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex flex-col gap-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Date" required error={errors.date}>
            <Input type="date" value={date} max={todayIso} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Odometer (km)" optional error={errors.odometer}>
            <Input inputMode="numeric" value={odometer} onChange={(e) => setOdometer(e.target.value)} autoComplete="off" />
          </Field>
        </div>
        <Field label="Work done" required error={errors.work}>
          <Textarea value={work} onChange={(e) => setWork(e.target.value)} rows={3} />
        </Field>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Cost (₹)" optional error={errors.cost}>
            <Input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="0" autoComplete="off" />
          </Field>
          <Field label="Garage" optional>
            <Input value={garage} onChange={(e) => setGarage(e.target.value)} autoComplete="off" />
          </Field>
        </div>
        {errors.form && <Alert title="Couldn't save">{errors.form}</Alert>}
      </div>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={() => void save()} loading={saving} loadingText="Saving…">
          Save
        </Button>
      </DialogFooter>
    </>
  );
}
