// /admin/fleet/:id and /admin/fleet/new: car details, prices, photos, papers, maintenance,
// service log and booking history (FLT-02..09). A new car shows only Details until it is saved.
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ArrowLeft, CalendarPlus, Wrench } from 'lucide-react';
import { Badge } from '@/components/ui/Badges';
import { ButtonLink } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Field';
import { EmptyState, PageHeader, Tabs, type TabDef } from '@/components/ui/Layout';
import { PageSpinner } from '@/components/ui/Spinner';
import { errorMessage } from '@/lib/errors';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import type { Car } from '@/types/db';
import { useCars } from '../../hooks/queries';
import { CarBookingsTab } from './CarBookingsTab';
import { CarDetailsForm } from './CarDetailsForm';
import { CarMaintenanceTab } from './CarMaintenanceTab';
import { CarPapersTab } from './CarPapersTab';
import { CarPhotosTab } from './CarPhotosTab';
import { CarPricesTab } from './CarPricesTab';
import { CarServiceLogTab } from './CarServiceLogTab';
import { UUID_RE, useCar, useCarPhotos, useMaintenanceNow, usePaperProblems } from './fleetData';

const TAB_IDS = ['details', 'prices', 'photos', 'papers', 'maintenance', 'service', 'bookings'] as const;
type TabId = (typeof TAB_IDS)[number];
const isTab = (v: string | null): v is TabId => (TAB_IDS as readonly string[]).includes(v ?? '');

export default function CarDetailPage() {
  const { id = '' } = useParams();
  return id === 'new' ? <NewCarPage /> : <ExistingCarPage key={id} id={id} />;
}

function BackToFleet() {
  return (
    <Link to="/admin/fleet" className="inline-flex min-h-11 items-center gap-1.5 self-start font-semibold">
      <ArrowLeft size={18} aria-hidden="true" /> Fleet
    </Link>
  );
}

function NewCarPage() {
  useDocumentMeta({ title: 'Add a car · KSR admin', noindex: true });
  const navigate = useNavigate();
  const cars = useCars();
  const nextSortOrder = cars.data?.length ? Math.max(...cars.data.map((c) => c.sort_order)) + 10 : 10;
  return (
    <>
      <PageHeader back={<BackToFleet />} title="Add a car" description="Save the details first, then add photos, papers and maintenance." />
      {cars.isLoading ? (
        <PageSpinner />
      ) : (
        <CarDetailsForm car={null} nextSortOrder={nextSortOrder} onSaved={(car) => navigate(`/admin/fleet/${car.id}?tab=photos`, { replace: true })} />
      )}
    </>
  );
}

function ExistingCarPage({ id }: { id: string }) {
  const car = useCar(id);
  useDocumentMeta({ title: `${car.data?.display_name ?? 'Car'} · KSR admin`, noindex: true });

  const notFound = (
    <>
      <PageHeader back={<BackToFleet />} title="Car not found" />
      <EmptyState title="We couldn't find this car" action={<ButtonLink to="/admin/fleet">Back to fleet</ButtonLink>}>
        It may have been deleted. Check the link or pick the car from the fleet list.
      </EmptyState>
    </>
  );

  if (!UUID_RE.test(id)) return notFound;
  if (car.isLoading) return <PageSpinner label="Loading car" />;
  if (car.error) {
    return (
      <>
        <PageHeader back={<BackToFleet />} title="Car" />
        <Alert title="Couldn't load this car">{errorMessage(car.error)}</Alert>
      </>
    );
  }
  if (!car.data) return notFound;
  return <CarTabs car={car.data} />;
}

function CarTabs({ car }: { car: Car }) {
  const [params, setParams] = useSearchParams();
  const photos = useCarPhotos(car.id);
  const problems = usePaperProblems(car.id);
  const maintenanceNow = useMaintenanceNow();
  const tab = params.get('tab');
  const inMaintenance = maintenanceNow.data?.has(car.id);
  const expired = problems.data?.filter((p) => p.problem === 'expired').length ?? 0;
  const missing = problems.data?.filter((p) => p.problem === 'missing').length ?? 0;

  const tabs: TabDef[] = [
    { id: 'details', label: 'Details', content: <CarDetailsForm key={car.id} car={car} /> },
    { id: 'prices', label: 'Prices', content: <CarPricesTab car={car} /> },
    {
      id: 'photos',
      label: 'Photos',
      badge: photos.data ? (
        <Badge tone={photos.data.length ? 'outline' : 'amber'}>{photos.data.length ? photos.data.length : 'None'}</Badge>
      ) : undefined,
      content: <CarPhotosTab car={car} />,
    },
    {
      id: 'papers',
      label: 'Papers',
      badge: expired ? <Badge tone="red">Expired</Badge> : missing ? <Badge tone="amber">Missing</Badge> : undefined,
      content: <CarPapersTab car={car} />,
    },
    {
      id: 'maintenance',
      label: 'Maintenance',
      badge: inMaintenance ? <Badge tone="amber">Now</Badge> : undefined,
      content: <CarMaintenanceTab car={car} />,
    },
    { id: 'service', label: 'Service log', content: <CarServiceLogTab car={car} /> },
    { id: 'bookings', label: 'Bookings', content: <CarBookingsTab car={car} /> },
  ];

  return (
    <>
      <PageHeader
        back={<BackToFleet />}
        title={car.display_name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{car.registration_number ?? 'No registration number'}</span>
            <Badge tone={car.status === 'active' ? 'green' : 'grey'}>{car.status === 'active' ? 'Active' : 'Inactive'}</Badge>
            {inMaintenance && (
              <Badge tone="amber">
                <Wrench size={12} aria-hidden="true" /> In maintenance now
              </Badge>
            )}
          </span>
        }
        actions={
          <ButtonLink to={`/admin/bookings/new?car=${car.id}`} variant="secondary" size="sm" icon={<CalendarPlus size={18} aria-hidden="true" />}>
            New booking
          </ButtonLink>
        }
      />
      <Tabs
        tabs={tabs}
        initial={isTab(tab) ? tab : 'details'}
        onChange={(t) =>
          setParams(
            (prev) => {
              const next = new URLSearchParams(prev);
              next.set('tab', t);
              return next;
            },
            { replace: true },
          )
        }
      />
    </>
  );
}
