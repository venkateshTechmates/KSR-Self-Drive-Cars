// Search-and-choose control for linking something to a customer (document upload, merge, privacy requests).
import { useId, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/Badges';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Spinner';
import { errorMessage } from '@/lib/errors';
import { formatPhone } from '@/lib/format';
import type { Customer } from '@/types/db';
import { qk } from '../../hooks/queries';
import { searchCustomers, useDebounced } from './customerSearch';

export type PickedCustomer = Pick<Customer, 'id' | 'full_name' | 'phone'>;

interface Props {
  value: PickedCustomer | null;
  onChange: (customer: Customer | null) => void;
  label?: string;
  hint?: string;
  /** Leave this customer out of the results (e.g. the record being merged into). */
  excludeId?: string;
  optional?: boolean;
  error?: string | null;
}

export function CustomerPicker({ value, onChange, label = 'Customer', hint, excludeId, optional, error }: Props) {
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 300);
  const resultsId = useId();
  const results = useQuery({
    queryKey: [...qk.customers, 'picker', q],
    enabled: q.length >= 2 && !value,
    queryFn: () => searchCustomers(q, { limit: 10 }),
    placeholderData: keepPreviousData,
  });
  const rows = (results.data ?? []).filter((c) => c.id !== excludeId);

  if (value) {
    return (
      <div className="flex flex-col gap-2">
        <p className="m-0 font-semibold">{label}</p>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line-input bg-subtle px-4 py-3">
          <div className="min-w-0">
            <p className="m-0 font-semibold">{value.full_name}</p>
            <p className="m-0 text-sm text-muted">{formatPhone(value.phone) || 'No mobile'}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => onChange(null)}>
            Change
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Field label={label} hint={hint ?? 'Search by name, mobile or licence number.'} optional={optional} error={error}>
        <Input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoComplete="off"
          aria-controls={resultsId}
          placeholder="Name or mobile"
        />
      </Field>
      <div id={resultsId} aria-live="polite">
        {q.length >= 2 &&
          (results.isLoading ? (
            <div className="flex items-center gap-2 py-2 text-sm text-muted">
              <Spinner size={16} /> Searching…
            </div>
          ) : results.error ? (
            <p className="m-0 text-sm font-semibold text-danger">{errorMessage(results.error)}</p>
          ) : rows.length === 0 ? (
            <p className="m-0 text-sm text-muted">No customers match “{q}”.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1 rounded-xl border border-line-card p-1" aria-label="Matching customers">
              {rows.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(c);
                      setSearch('');
                    }}
                    className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left hover:bg-subtle focus-visible:bg-subtle"
                  >
                    <span className="min-w-0">
                      <span className="block font-semibold">{c.full_name}</span>
                      <span className="block text-sm text-muted">{formatPhone(c.phone)}</span>
                    </span>
                    {c.blocked && <Badge tone="red">Blocked</Badge>}
                  </button>
                </li>
              ))}
            </ul>
          ))}
      </div>
    </div>
  );
}
