// Privacy requests (DP-04, DP-05): data and display rules shared by the list and its dialogs.
import { useQuery } from '@tanstack/react-query';
import type { DataRequestKind } from '@shared/constants.ts';
import { addDaysIso, daysBetween, istDateIso, istStartOfDay } from '@shared/time.ts';
import { api } from '@/integrations/api/client';
import { unwrap } from '@/lib/errors';
import type { DataRequest } from '@/types/db';
import { qk } from '../../hooks/queries';

export type RequestStatus = DataRequest['status'];

export type RequestRow = DataRequest & {
  customer: { id: string; full_name: string; phone: string | null; erased_at: string | null } | null;
};

export const REQUEST_STATUSES: RequestStatus[] = ['open', 'in_progress', 'done', 'refused'];

export const REQUEST_STATUS_LABELS: Record<RequestStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  done: 'Done',
  refused: 'Refused',
};

export const REQUEST_STATUS_TONES: Record<RequestStatus, 'amber' | 'blue' | 'green' | 'grey'> = {
  open: 'amber',
  in_progress: 'blue',
  done: 'green',
  refused: 'grey',
};

/** Where to act on each kind of request. */
export const KIND_NEXT_STEP: Record<DataRequestKind, string> = {
  access: 'Export their data from the customer page and send it to them.',
  correction: 'Edit their details on the customer page.',
  erasure: 'Erase their data from the customer page (Owner only). Erasure waits while a booking, payment or hold is open; tell them why.',
  grievance: 'Reply to them and record the outcome here.',
  consent_withdrawal: 'Note the withdrawal on the customer page and stop using their data for that purpose.',
};

/** Days given by default before a request is due. Staff set the deadline the law requires. */
export const DEFAULT_DUE_DAYS = 30;

export const isOpen = (r: Pick<DataRequest, 'status'>) => r.status === 'open' || r.status === 'in_progress';

/** Whole IST days until the due date (negative when overdue), or null without a due date. */
export function daysLeft(r: Pick<DataRequest, 'due_at'>, now: number): number | null {
  return r.due_at ? daysBetween(istDateIso(now), istDateIso(r.due_at)) : null;
}

export const isOverdue = (r: Pick<DataRequest, 'status' | 'due_at'>, now: number) =>
  isOpen(r) && Boolean(r.due_at) && Date.parse(r.due_at!) < now;

/** Last second of an IST date, so a request is due at the end of its due day. */
export const endOfIstDay = (dateIso: string) => new Date(istStartOfDay(addDaysIso(dateIso, 1)).getTime() - 1000).toISOString();

export function useDataRequests() {
  return useQuery({
    queryKey: qk.dataRequests,
    queryFn: async () =>
      (unwrap(
        await api
          .from('data_requests')
          .select('*, customer:customers(id, full_name, phone, erased_at)')
          .order('received_at', { ascending: false })
          .limit(500),
      ) ?? []) as unknown as RequestRow[],
  });
}
