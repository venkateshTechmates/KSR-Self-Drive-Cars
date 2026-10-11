import { useId, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Card({ children, className, as: Tag = 'section' }: { children: ReactNode; className?: string; as?: 'section' | 'div' | 'article' }) {
  return <Tag className={cn('rounded-2xl border border-line-card bg-surface', className)}>{children}</Tag>;
}

export function CardHeader({ title, actions, description, className }: { title: ReactNode; actions?: ReactNode; description?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3 border-b border-line-card px-4 py-3 sm:px-5', className)}>
      <div className="min-w-0">
        <h2 className="m-0 text-[17px] font-bold">{title}</h2>
        {description && <p className="m-0 mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-4 py-4 sm:px-5', className)}>{children}</div>;
}

export function PageHeader({
  title,
  description,
  actions,
  back,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:mb-6">
      {back}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="m-0 text-[28px] leading-tight font-extrabold sm:text-[34px]">{title}</h1>
          {description && <div className="m-0 mt-1 text-[15px] text-muted">{description}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-line-dash bg-subtle px-6 py-10 text-center">
      <p className="m-0 font-semibold">{title}</p>
      {children && <div className="max-w-md text-[15px] text-muted">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Definition list of label/value pairs. */
export function KeyValue({ items, className }: { items: Array<[ReactNode, ReactNode] | null | false>; className?: string }) {
  return (
    <dl className={cn('m-0 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2', className)}>
      {items.filter(Boolean).map((item, i) => {
        const [k, v] = item as [ReactNode, ReactNode];
        return (
          <div key={i} className="min-w-0">
            <dt className="text-sm text-muted">{k}</dt>
            <dd className="m-0 break-words font-semibold">{v ?? '—'}</dd>
          </div>
        );
      })}
    </dl>
  );
}

export interface TabDef {
  id: string;
  label: ReactNode;
  content: ReactNode;
  badge?: ReactNode;
}

/**
 * WAI-ARIA tabs with arrow-key navigation. Inactive panels unmount unless `keepMounted`
 * (use it for forms, so unsaved edits survive switching tabs).
 */
export function Tabs({
  tabs,
  initial,
  onChange,
  keepMounted = false,
}: {
  tabs: TabDef[];
  initial?: string;
  onChange?: (id: string) => void;
  keepMounted?: boolean;
}) {
  const [active, setActive] = useState(initial ?? tabs[0]?.id);
  const base = useId();
  const select = (id: string) => {
    setActive(id);
    onChange?.(id);
  };
  return (
    <div>
      <div role="tablist" className="-mx-4 flex gap-1 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0">
        {tabs.map((t, i) => (
          <button
            key={t.id}
            id={`${base}-tab-${t.id}`}
            role="tab"
            type="button"
            aria-selected={active === t.id}
            aria-controls={`${base}-panel-${t.id}`}
            tabIndex={active === t.id ? 0 : -1}
            onClick={() => select(t.id)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
              const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
              select(next.id);
              document.getElementById(`${base}-tab-${next.id}`)?.focus();
            }}
            className={cn(
              'inline-flex min-h-11 shrink-0 items-center gap-2 border-b-[3px] px-3 font-semibold',
              active === t.id ? 'border-ink text-ink' : 'border-transparent text-muted hover:text-ink',
            )}
          >
            {t.label}
            {t.badge}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div
          key={t.id}
          id={`${base}-panel-${t.id}`}
          role="tabpanel"
          aria-labelledby={`${base}-tab-${t.id}`}
          hidden={active !== t.id}
          className="pt-5"
        >
          {(keepMounted || active === t.id) && t.content}
        </div>
      ))}
    </div>
  );
}

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
  /** Hide this column in the phone card layout. */
  hideOnMobile?: boolean;
}

/**
 * Table on wide screens, stacked cards on phones (ADM-08). `mobileTitle` renders the card
 * heading; other columns become label/value lines.
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  onRowClick,
  mobileTitle,
  caption,
  empty,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  mobileTitle?: (row: T) => ReactNode;
  caption?: string;
  empty?: ReactNode;
}) {
  if (rows.length === 0) return <>{empty ?? <EmptyState title="Nothing here yet" />}</>;
  return (
    <>
      <div className="hidden overflow-x-auto rounded-2xl border border-line-card bg-surface md:block">
        <table className="w-full border-collapse text-left text-[15px]">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead>
            <tr className="border-b border-line-card bg-subtle">
              {columns.map((c) => (
                <th key={c.key} scope="col" className={cn('px-3 py-2.5 text-[13px] font-semibold whitespace-nowrap text-muted', c.className)}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn('border-b border-line-card last:border-0', onRowClick && 'cursor-pointer hover:bg-subtle')}
              >
                {columns.map((c) => (
                  <td key={c.key} className={cn('px-3 py-2.5 align-top', c.className)}>
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="m-0 flex list-none flex-col gap-3 p-0 md:hidden">
        {rows.map((row) => (
          <li key={rowKey(row)}>
            <div
              className={cn('rounded-2xl border border-line-card bg-surface p-4', onRowClick && 'cursor-pointer active:bg-subtle')}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {mobileTitle && <div className="mb-2">{mobileTitle(row)}</div>}
              <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[15px]">
                {columns
                  .filter((c) => !c.hideOnMobile)
                  .map((c) => (
                    <div key={c.key} className="contents">
                      <dt className="text-muted">{c.header}</dt>
                      <dd className="m-0 min-w-0 text-right">{c.cell(row)}</dd>
                    </div>
                  ))}
              </dl>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Horizontal wrap of filter controls above a list. */
export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mb-4 flex flex-wrap items-end gap-3', className)}>{children}</div>;
}

/** Pill-shaped toggle chip, used for filters. */
export function Chip({
  pressed,
  onClick,
  children,
  count,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
  count?: number;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border px-4 text-[15px] font-semibold whitespace-nowrap',
        pressed ? 'border-ink bg-ink text-white' : 'border-line-input bg-white text-ink hover:border-ink',
      )}
    >
      {children}
      {count !== undefined && <span className="font-medium opacity-80">{count}</span>}
    </button>
  );
}
