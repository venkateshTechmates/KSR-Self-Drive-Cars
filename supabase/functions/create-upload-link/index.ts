// create-upload-link (admin, P1; DOC-16).
// POST JSON { customer_id, booking_id? }
// 200 { url: `${SITE_URL}/upload/${token}`, expires_at, message }
// The token is shown once; only its SHA-256 is stored. Links are one-time and last 24 hours.
import { sha256Hex } from '../_shared/domain/documents.ts';
import { fillTemplate } from '../_shared/domain/settings.ts';
import { requireRole, requireUser, serviceClient } from '../_shared/clients.ts';
import { siteUrl } from '../_shared/env.ts';
import { allowMethods, fromPgError, handler, HttpError, json, optUuid, readJson, requireUuid } from '../_shared/http.ts';
import { clientIp, userAgent } from '../_shared/request.ts';
import { loadSettings } from '../_shared/settings.ts';

const LINK_HOURS = 24;

/** 32 random bytes as base64url (43 characters, no padding). */
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

Deno.serve(
  handler('create-upload-link', async (req) => {
    allowMethods(req, ['POST']);
    const ctx = await requireUser(req);
    requireRole(ctx);
    const body = await readJson(req);
    const customerId = requireUuid(body.customer_id, 'customer_id', 'Customer not found.');
    const bookingId = optUuid(body.booking_id, 'booking_id');

    // Selecting as the caller applies RLS, so Staff only reach today's customers.
    const { data: customer, error: customerError } = await ctx.client
      .from('customers')
      .select('id, full_name, erased_at')
      .eq('id', customerId)
      .maybeSingle();
    if (customerError) throw fromPgError(customerError, 'create-upload-link');
    if (!customer || customer.erased_at) throw new HttpError(404, 'Customer not found.', 'not_found');

    if (bookingId) {
      const { data: booking, error: bookingError } = await ctx.client
        .from('bookings')
        .select('id, customer_id')
        .eq('id', bookingId)
        .maybeSingle();
      if (bookingError) throw fromPgError(bookingError, 'create-upload-link');
      if (!booking || booking.customer_id !== customerId) throw new HttpError(404, 'Booking not found.', 'not_found');
    }

    const site = siteUrl(req);
    if (!site) throw new HttpError(500, 'The site address is not set up. Ask the Owner to set SITE_URL.', 'config');

    const service = serviceClient();
    const token = newToken();
    const expiresAt = new Date(Date.now() + LINK_HOURS * 3600_000).toISOString();
    const { data: link, error: insertError } = await service
      .from('upload_links')
      .insert({
        customer_id: customerId,
        booking_id: bookingId,
        token_hash: await sha256Hex(new TextEncoder().encode(token)),
        expires_at: expiresAt,
        created_by: ctx.user.id,
      })
      .select('id')
      .single();
    if (insertError) throw fromPgError(insertError, 'create-upload-link');

    const { error: auditError } = await service.rpc('write_audit', {
      p_action: 'upload_link.create',
      p_entity_type: 'customers',
      p_entity_id: customerId,
      p_before: null,
      p_after: { upload_link_id: link.id, booking_id: bookingId, expires_at: expiresAt },
      p_actor: ctx.user.id,
      p_ip: clientIp(req),
      p_user_agent: userAgent(req),
    });
    if (auditError) throw fromPgError(auditError, 'create-upload-link');

    const url = `${site}/upload/${token}`;
    const { templates } = await loadSettings(service, ['templates']);
    const firstName = String(customer.full_name ?? '').trim().split(/\s+/)[0] ?? '';
    const message = fillTemplate(templates.upload_link, { name: firstName, link: url });

    return json({ url, expires_at: expiresAt, message });
  }),
);
