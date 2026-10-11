import { Link } from 'react-router';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { SitePage } from '../components/SiteChrome';

export default function NotFoundPage() {
  useDocumentMeta({ title: 'Page not found | KSR Self Drive Cars', noindex: true });
  return (
    <SitePage>
      <div className="mx-auto max-w-[640px] px-5 py-20 sm:px-6">
        <h1 className="display m-0 text-[56px]">Page not found</h1>
        <p className="m-0 mt-4 text-lg text-ink-2">That page doesn&apos;t exist. Our cars are still here.</p>
        <Link to="/" className="mt-6 inline-block text-lg font-semibold">
          Go to the home page
        </Link>
      </div>
    </SitePage>
  );
}
