// /admin/settings (SET-01..07, Owner only). Each tab loads its own setting and saves it on its
// own; every change is written to the audit log by the database.
import { useSearchParams } from 'react-router';
import { PageHeader, Tabs, type TabDef } from '@/components/ui/Layout';
import { BookingRulesTab } from './BookingRulesTab';
import { BusinessTab } from './BusinessTab';
import { DocumentsTab } from './DocumentsTab';
import { NotificationsTab } from './NotificationsTab';
import { PoliciesTab } from './PoliciesTab';
import { SecurityTab } from './SecurityTab';
import { TemplatesTab } from './TemplatesTab';

const TABS: TabDef[] = [
  { id: 'business', label: 'Business', content: <BusinessTab /> },
  { id: 'booking-rules', label: 'Booking rules', content: <BookingRulesTab /> },
  { id: 'policies', label: 'Policies', content: <PoliciesTab /> },
  { id: 'templates', label: 'Message templates', content: <TemplatesTab /> },
  { id: 'notifications', label: 'Notifications', content: <NotificationsTab /> },
  { id: 'documents', label: 'Documents & retention', content: <DocumentsTab /> },
  { id: 'security', label: 'Security', content: <SecurityTab /> },
];

export default function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const initial = TABS.some((t) => t.id === requested) ? requested! : 'business';

  return (
    <>
      <PageHeader
        title="Settings"
        description="Business details, booking rules, policies and access. Each tab saves on its own; every change is recorded in the audit log."
      />
      <Tabs keepMounted tabs={TABS} initial={initial} onChange={(id) => setParams({ tab: id }, { replace: true })} />
    </>
  );
}
