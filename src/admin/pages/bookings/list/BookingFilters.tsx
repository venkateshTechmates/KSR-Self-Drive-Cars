// Search box and filters for the bookings list (BKA-01).
import { useState, type FormEvent } from 'react';
import { Search, SlidersHorizontal } from 'lucide-react';
import { BOOKING_STATUS_LABELS, SOURCE_LABELS, BOOKING_SOURCES, type BookingSource } from '@shared/constants.ts';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { Chip } from '@/components/ui/Layout';
import type { Car } from '@/types/db';
import {
  extraFilterCount,
  STATUS_FILTERS,
  VIEW_LABELS,
  type ListFilters,
  type ListView,
  type StatusFilter,
} from './useBookingsList';

const statusLabel = (s: StatusFilter) => (s === 'overdue' ? 'Overdue' : BOOKING_STATUS_LABELS[s]);

interface Props {
  filters: ListFilters;
  cars: Car[];
  searchText: string;
  onSearchText: (value: string) => void;
  /** Apply the search box now (Enter / Search button) instead of waiting for the pause. */
  onSearchSubmit: () => void;
  onChange: (patch: Partial<ListFilters>) => void;
  onClear: () => void;
}

export function BookingFilters({ filters, cars, searchText, onSearchText, onSearchSubmit, onChange, onClear }: Props) {
  const extra = extraFilterCount(filters);
  // Open on first render when the URL already has these filters; after that the user decides.
  const [startOpen] = useState(extra > 0);
  const anyFilter = extra > 0 || filters.statuses.length > 0 || Boolean(filters.q.trim()) || filters.view !== 'upcoming';

  function submit(e: FormEvent) {
    e.preventDefault();
    onSearchSubmit();
  }

  function toggleStatus(s: StatusFilter) {
    const on = filters.statuses.includes(s);
    const statuses = on ? filters.statuses.filter((x) => x !== s) : [...filters.statuses, s];
    // Overdue bookings were picked up in the past, so show every date when it is chosen.
    const view: ListView = !on && s === 'overdue' ? 'all' : filters.view;
    onChange({ statuses, view });
  }

  function setDate(key: 'from' | 'to', value: string) {
    // A date range replaces the Upcoming / Past window.
    onChange({ [key]: value, view: value ? 'all' : filters.view });
  }

  return (
    <div className="mb-4 flex flex-col gap-3">
      <form role="search" onSubmit={submit} className="flex items-end gap-2">
        <Field label="Search bookings" hideLabel className="flex-1">
          <Input
            type="search"
            value={searchText}
            onChange={(e) => onSearchText(e.target.value)}
            placeholder="Booking code, customer, mobile or car number"
            autoComplete="off"
            enterKeyHint="search"
          />
        </Field>
        <Button type="submit" variant="dark" icon={<Search size={18} aria-hidden="true" />} className="shrink-0">
          <span className="sr-only sm:not-sr-only">Search</span>
        </Button>
      </form>

      <div role="group" aria-label="Which bookings" className="flex flex-wrap gap-2">
        {(Object.keys(VIEW_LABELS) as ListView[]).map((v) => (
          <Chip key={v} pressed={filters.view === v} onClick={() => onChange({ view: v })}>
            {VIEW_LABELS[v]}
          </Chip>
        ))}
      </div>

      <div role="group" aria-label="Status" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
        {STATUS_FILTERS.map((s) => (
          <Chip key={s} pressed={filters.statuses.includes(s)} onClick={() => toggleStatus(s)}>
            {statusLabel(s)}
          </Chip>
        ))}
      </div>

      <details className="group rounded-2xl border border-line-card bg-surface" open={startOpen || undefined}>
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 font-semibold [&::-webkit-details-marker]:hidden">
          <SlidersHorizontal size={18} aria-hidden="true" />
          More filters
          {extra > 0 && <span className="rounded-full bg-ink px-2 text-sm text-white">{extra}</span>}
          <span className="ml-auto text-sm font-normal text-muted group-open:hidden">Car, source, dates</span>
        </summary>
        <div className="grid grid-cols-1 gap-4 border-t border-line-card px-4 py-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Car">
            <Select value={filters.carId} onChange={(e) => onChange({ carId: e.target.value })}>
              <option value="">All cars</option>
              {cars.map((c) => (
                <option key={c.id} value={c.id}>
                  {`${c.display_name}${c.registration_number ? ` · ${c.registration_number}` : ''}${c.status === 'inactive' ? ' (inactive)' : ''}`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Source">
            <Select value={filters.source} onChange={(e) => onChange({ source: e.target.value as BookingSource | '' })}>
              <option value="">All sources</option>
              {BOOKING_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {SOURCE_LABELS[s]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Pickup from">
            <Input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => setDate('from', e.target.value)} />
          </Field>
          <Field label="Pickup to">
            <Input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => setDate('to', e.target.value)} />
          </Field>
        </div>
      </details>

      {anyFilter && (
        <div>
          <Button variant="ghost" size="sm" onClick={onClear}>
            Clear search and filters
          </Button>
        </div>
      )}
    </div>
  );
}
