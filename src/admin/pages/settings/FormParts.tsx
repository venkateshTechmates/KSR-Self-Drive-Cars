// Shared layout pieces for the settings tabs.
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Field';
import { Card, CardBody, CardHeader } from '@/components/ui/Layout';
import { Spinner } from '@/components/ui/Spinner';
import { errorMessage } from '@/lib/errors';

/** Loading and error states around a settings form. */
export function Loader<T>({ query, children }: { query: { data: T | undefined; error: unknown }; children: (data: T) => ReactNode }) {
  if (query.error) {
    return (
      <Alert tone="error" title="Couldn't load these settings">
        {errorMessage(query.error)} Reload the page to try again.
      </Alert>
    );
  }
  if (query.data === undefined) {
    return (
      <div className="flex justify-center py-10 text-muted" role="status">
        <Spinner size={24} />
        <span className="sr-only">Loading</span>
      </div>
    );
  }
  return <>{children(query.data)}</>;
}

export function FormCard({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardHeader title={title} description={description} />
      <CardBody className="flex flex-col gap-4">{children}</CardBody>
    </Card>
  );
}

/** Sticky save row at the bottom of a form, with an unsaved-changes note. */
export function SaveBar({ dirty, saving, label = 'Save changes', hasErrors }: { dirty: boolean; saving: boolean; label?: string; hasErrors?: boolean }) {
  return (
    <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-end gap-3 border-t border-line bg-page/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-2xl sm:border">
      <p className="m-0 mr-auto text-[15px] text-muted" aria-live="polite">
        {hasErrors ? <span className="font-semibold text-danger">Fix the highlighted fields, then save.</span> : dirty ? 'You have unsaved changes.' : 'All changes saved.'}
      </p>
      <Button type="submit" loading={saving} loadingText="Saving…">
        {label}
      </Button>
    </div>
  );
}
