// /admin dashboard (6.3, DSH-01..06). Staff see Today and Overdue only (2.2); their
// row-level security already limits the rows to today ± 1 day.
import { Plus } from 'lucide-react';
import { ButtonLink } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/Layout';
import { formatDate, istDateIso } from '@/lib/format';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { useNow } from '@/lib/useNow';
import { isOwnerOrManager, useAuth } from '../../auth/AuthProvider';
import { DocumentAlertsCard, FleetNowCard, NeedsActionCard, OverdueCard, ThisMonthCard, TodayCard } from './DashboardCards';

export default function DashboardPage() {
  useDocumentMeta({ title: 'Dashboard · KSR admin', noindex: true });
  const { role } = useAuth();
  const om = isOwnerOrManager(role);
  const now = useNow();
  const todayIso = istDateIso(now);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={`${formatDate(now)} · times in IST`}
        actions={
          om && (
            <ButtonLink to="/admin/bookings/new" icon={<Plus size={18} aria-hidden="true" />}>
              New booking
            </ButtonLink>
          )
        }
      />
      {om ? (
        <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-5">
            <NeedsActionCard now={now} />
            <OverdueCard now={now} />
            <TodayCard now={now} todayIso={todayIso} />
          </div>
          <div className="flex min-w-0 flex-col gap-5">
            <FleetNowCard now={now} />
            <DocumentAlertsCard now={now} todayIso={todayIso} />
            <ThisMonthCard todayIso={todayIso} />
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <TodayCard now={now} todayIso={todayIso} />
          <OverdueCard now={now} />
        </div>
      )}
    </>
  );
}
