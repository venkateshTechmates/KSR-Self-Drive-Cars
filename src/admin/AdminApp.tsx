// Admin bundle entry (code-split from the public site). Routes from PRD 6.2.
import { lazy, Suspense, type ReactNode } from 'react';
import { Route, Routes } from 'react-router';
import type { AppRole } from '@shared/constants.ts';
import { EmptyState } from '@/components/ui/Layout';
import { PageSpinner } from '@/components/ui/Spinner';
import { AdminLayout } from './AdminLayout';
import { AuthProvider } from './auth/AuthProvider';
import { RequireAdmin, RequireRole } from './auth/guards';
import { LoginPage, MfaPage, ResetPasswordPage } from './pages/auth/AuthPages';

const DashboardPage = lazy(() => import('./pages/dashboard/DashboardPage'));
const BookingsListPage = lazy(() => import('./pages/bookings/BookingsListPage'));
const NewBookingPage = lazy(() => import('./pages/bookings/NewBookingPage'));
const BookingDetailPage = lazy(() => import('./pages/bookings/BookingDetailPage'));
const BookingPrintPage = lazy(() => import('./pages/bookings/BookingPrintPage'));
const CalendarPage = lazy(() => import('./pages/calendar/CalendarPage'));
const FleetListPage = lazy(() => import('./pages/fleet/FleetListPage'));
const CarDetailPage = lazy(() => import('./pages/fleet/CarDetailPage'));
const CustomersListPage = lazy(() => import('./pages/customers/CustomersListPage'));
const CustomerDetailPage = lazy(() => import('./pages/customers/CustomerDetailPage'));
const DocumentCentrePage = lazy(() => import('./pages/documents/DocumentCentrePage'));
const PaymentsPage = lazy(() => import('./pages/payments/PaymentsPage'));
const ReportsPage = lazy(() => import('./pages/reports/ReportsPage'));
const DataRequestsPage = lazy(() => import('./pages/requests/DataRequestsPage'));
const SettingsPage = lazy(() => import('./pages/settings/SettingsPage'));
const StaffPage = lazy(() => import('./pages/staff/StaffPage'));
const AuditLogPage = lazy(() => import('./pages/audit/AuditLogPage'));

const OM: readonly AppRole[] = ['owner', 'manager'];
const O: readonly AppRole[] = ['owner'];

const only = (roles: readonly AppRole[], el: ReactNode) => <RequireRole roles={roles}>{el}</RequireRole>;

export default function AdminApp() {
  return (
    <AuthProvider>
      <Suspense fallback={<PageSpinner />}>
        <Routes>
          <Route path="login" element={<LoginPage />} />
          <Route path="mfa" element={<MfaPage />} />
          <Route path="reset-password" element={<ResetPasswordPage />} />
          <Route
            element={
              <RequireAdmin>
                <AdminLayout />
              </RequireAdmin>
            }
          >
            <Route index element={<DashboardPage />} />
            <Route path="bookings" element={<BookingsListPage />} />
            <Route path="bookings/new" element={only(OM, <NewBookingPage />)} />
            <Route path="bookings/:code" element={<BookingDetailPage />} />
            <Route path="bookings/:code/print" element={<BookingPrintPage />} />
            <Route path="calendar" element={only(OM, <CalendarPage />)} />
            <Route path="fleet" element={only(OM, <FleetListPage />)} />
            <Route path="fleet/:id" element={only(OM, <CarDetailPage />)} />
            <Route path="customers" element={only(OM, <CustomersListPage />)} />
            <Route path="customers/:id" element={only(OM, <CustomerDetailPage />)} />
            <Route path="documents" element={only(OM, <DocumentCentrePage />)} />
            <Route path="payments" element={only(OM, <PaymentsPage />)} />
            <Route path="reports" element={only(OM, <ReportsPage />)} />
            <Route path="requests" element={only(OM, <DataRequestsPage />)} />
            <Route path="settings" element={only(O, <SettingsPage />)} />
            <Route path="staff" element={only(O, <StaffPage />)} />
            <Route path="audit" element={only(O, <AuditLogPage />)} />
            <Route path="*" element={<EmptyState title="Page not found" />} />
          </Route>
        </Routes>
      </Suspense>
    </AuthProvider>
  );
}
