// retention-purge (cron, P0; DOC-15, Section 10.4).
// POST with header x-cron-secret (daily job), the service-role key, or as the Owner signed in
// with two-step verification (aal2).
// Erases files of soft-deleted and past-retention documents (skipping holds), then their
// records (each erasure is audited), then stale requests, orphan customers and old logs.
// 200 { erased, failed, batches, stale: { requests, customers, audit_entries } }
import { isInternalRequest } from '../_shared/auth.ts';
import { requireRole, requireUser, serviceClient } from '../_shared/clients.ts';
import { DOCUMENTS_BUCKET } from '../_shared/files.ts';
import { allowMethods, fromPgError, handler, HttpError, json } from '../_shared/http.ts';

const BATCH_SIZE = 200;
const MAX_BATCHES = 20;

interface DueDocument {
  id: string;
  storage_path: string;
  reason: string;
}

Deno.serve(
  handler('retention-purge', async (req) => {
    allowMethods(req, ['POST']);
    if (!(await isInternalRequest(req))) {
      const ctx = await requireUser(req);
      requireRole(ctx, ['owner']);
      if (ctx.access.aal !== 'aal2') {
        throw new HttpError(403, 'Complete two-step verification to continue.', 'mfa_required');
      }
    }

    const service = serviceClient();

    // Bring retention dates up to date first (the daily job also does this just before).
    const { error: computeError } = await service.rpc('compute_document_retention');
    if (computeError) throw fromPgError(computeError, 'retention-purge');

    let erased = 0;
    let failed = 0;
    let batches = 0;
    const attempted = new Set<string>();

    while (batches < MAX_BATCHES) {
      const { data, error } = await service.rpc('_retention_due', { p_limit: BATCH_SIZE });
      if (error) throw fromPgError(error, 'retention-purge');
      // Rows that failed earlier in this run come back first; don't loop on them.
      const due = ((data ?? []) as DueDocument[]).filter((d) => !attempted.has(d.id));
      if (due.length === 0) break;
      batches++;
      for (const d of due) attempted.add(d.id);

      // Files first. Objects that are already missing count as gone.
      const { error: removeError } = await service.storage.from(DOCUMENTS_BUCKET).remove(due.map((d) => d.storage_path));
      if (removeError) {
        const msg = removeError.message ?? '';
        const alreadyGone = /not.?found/i.test(msg) && !/bucket/i.test(msg);
        if (!alreadyGone) {
          console.error('[retention-purge] storage remove failed', removeError.name ?? 'Error', msg);
          failed += due.length;
          break;
        }
      }

      // Then the records; the SQL writes a document.erase audit entry for each.
      for (const d of due) {
        const { error: eraseError } = await service.rpc('_erase_document', { p_doc: d.id, p_reason: d.reason });
        if (eraseError) {
          failed++;
          console.error('[retention-purge] erase failed', eraseError.code ?? '', eraseError.message ?? '');
        } else {
          erased++;
        }
      }
    }

    const { data: stale, error: staleError } = await service.rpc('_purge_stale_records');
    if (staleError) throw fromPgError(staleError, 'retention-purge');

    return json({ erased, failed, batches, stale });
  }),
);
