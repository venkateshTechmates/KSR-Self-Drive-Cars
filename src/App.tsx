import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router';
import { PageSpinner } from '@/components/ui/Spinner';
import { HomePage } from '@/site/pages/HomePage';

// The admin is its own bundle so visitors never download it (9.1).
const AdminApp = lazy(() => import('@/admin/AdminApp'));
const CarPage = lazy(() => import('@/site/pages/CarPage'));
const PolicyPage = lazy(() => import('@/site/pages/PolicyPage'));
const LookupPage = lazy(() => import('@/site/pages/LookupPage'));
const CustomerUploadPage = lazy(() => import('@/site/pages/CustomerUploadPage'));
const NotFoundPage = lazy(() => import('@/site/pages/NotFoundPage'));

export function App() {
  return (
    <Suspense fallback={<PageSpinner />}>
      <Routes>
        {/* The booking modal/sheet is a child route so the home page stays mounted underneath. */}
        <Route path="/" element={<HomePage />}>
          <Route path="book" element={null} />
          <Route path="book/:slug" element={null} />
        </Route>
        <Route path="/cars/:slug" element={<CarPage />} />
        <Route path="/privacy" element={<PolicyPage kind="privacy" />} />
        <Route path="/terms" element={<PolicyPage kind="terms" />} />
        <Route path="/cancellation" element={<PolicyPage kind="cancellation" />} />
        <Route path="/booking-status" element={<LookupPage />} />
        <Route path="/upload/:token" element={<CustomerUploadPage />} />
        <Route path="/admin/*" element={<AdminApp />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Suspense>
  );
}
