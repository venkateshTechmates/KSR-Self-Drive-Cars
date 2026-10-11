// document-view-url (admin, P0; DOC-05, DOC-06, DOC-07, DOC-17).
// POST JSON { document_id, download?: boolean }
// 200 { url, expires_at, filename, mime_type, watermark: string | null }
// 404 'Document not found.'   403 "You can't download this document. You can view it in the app."
// Every link issued is written to the audit log (document.view / document.download).
import { SIGNED_URL_SECONDS } from '../_shared/domain/documents.ts';
import { istParts } from '../_shared/domain/time.ts';
import { requireRole, requireUser, serviceClient } from '../_shared/clients.ts';
import { DOCUMENTS_BUCKET } from '../_shared/files.ts';
import { allowMethods, fromPgError, handler, HttpError, json, readJson, requireUuid } from '../_shared/http.ts';
import { clientIp, userAgent } from '../_shared/request.ts';

interface DocumentAccess {
  can_view: boolean;
  can_download: boolean;
  is_kyc?: boolean;
  label?: string;
  storage_path?: string;
  original_filename?: string;
  mime_type?: string;
  deleted?: boolean;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "DD Mon YYYY" in IST, e.g. "05 Oct 2026". */
function istDateLabel(d: Date): string {
  const p = istParts(d);
  return `${String(p.day).padStart(2, '0')} ${MONTHS[p.month - 1]} ${p.year}`;
}

const NOT_FOUND = 'Document not found.';

Deno.serve(
  handler('document-view-url', async (req) => {
    allowMethods(req, ['POST']);
    const ctx = await requireUser(req);
    requireRole(ctx);
    const body = await readJson(req);
    const documentId = requireUuid(body.document_id, 'document_id', NOT_FOUND);
    const download = body.download === true;

    // Role and staff-scope check as the caller (security definer, uses auth.uid()).
    const { data, error } = await ctx.client.rpc('document_access', { p_doc: documentId });
    if (error) throw fromPgError(error, 'document-view-url');
    const access = (data ?? { can_view: false, can_download: false }) as DocumentAccess;
    if (!access.can_view || !access.storage_path) throw new HttpError(404, NOT_FOUND, 'not_found');
    if (download && !access.can_download) {
      throw new HttpError(403, "You can't download this document. You can view it in the app.", 'forbidden');
    }

    const service = serviceClient();
    const filename = access.original_filename ?? 'document';
    const { data: signed, error: signError } = await service.storage
      .from(DOCUMENTS_BUCKET)
      .createSignedUrl(access.storage_path, SIGNED_URL_SECONDS, download ? { download: filename } : undefined);
    if (signError || !signed?.signedUrl) {
      console.error('[document-view-url] signing failed', signError?.name ?? 'Error', signError?.message ?? '');
      throw new HttpError(404, 'The file for this document is missing.', 'file_missing');
    }

    // Log before handing out the link; if logging fails, no link (DOC-07).
    const { error: logError } = await service.rpc('_log_document_access', {
      p_doc: documentId,
      p_action: download ? 'document.download' : 'document.view',
      p_actor: ctx.user.id,
      p_ip: clientIp(req),
      p_user_agent: userAgent(req),
    });
    if (logError) throw fromPgError(logError, 'document-view-url');

    const now = new Date();
    return json({
      url: signed.signedUrl,
      expires_at: new Date(now.getTime() + SIGNED_URL_SECONDS * 1000).toISOString(),
      filename,
      mime_type: access.mime_type ?? 'application/octet-stream',
      watermark: access.is_kyc ? `KSR Self Drive Cars — for rental verification only — ${istDateLabel(now)}` : null,
    });
  }),
);
