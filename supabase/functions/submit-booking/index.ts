// submit-booking (public, P0; Sections 5.4, 9.2, 9.3).
// POST JSON { car_id, package: '12h'|'24h', pickup_date: 'YYYY-MM-DD', pickup_time: 'HH:MM',
//             full_name, phone, dl_number, email?, consent: true, website?: '' (honeypot),
//             locale?: 'en'|'te'|'hi' }
// 200 { ok: true, booking_code, pickup_at, return_due_at, price_paise, phone }
// 200 { ok: false, error: 'clash', message, suggestions: [{ id, slug, display_name, price_12h_paise, price_24h_paise }] }
// 200 { ok: true, booking_code: null }                      honeypot filled (nothing saved)
// 422 { error: 'Check the highlighted fields.', code: 'validation', hint: { <field>: <message> } }
// 429 { error: 'Too many requests. Please call us.', code: 'rate_limited' }
import { LOCALES, type Locale } from '../_shared/domain/constants.ts';
import { type BookingField, MESSAGES, validateBookingRequest } from '../_shared/domain/validation.ts';
import { serviceClient } from '../_shared/clients.ts';
import { allowMethods, fromPgError, GENERIC_ERROR, handler, HttpError, json, optStr, readJson, str } from '../_shared/http.ts';
import { drainOutboxInBackground } from '../_shared/outbox.ts';
import { clientIp, ipHash, userAgent } from '../_shared/request.ts';
import { loadSettings } from '../_shared/settings.ts';

const BOOKING_FIELDS: readonly string[] = [
  'car_id',
  'package',
  'pickup',
  'full_name',
  'phone',
  'dl_number',
  'email',
  'consent',
] satisfies BookingField[];

interface CreateBookingResult {
  ok: boolean;
  error?: string;
  message?: string;
  suggestions?: unknown[];
  booking_id?: string;
  booking_code?: string;
  customer_id?: string;
  price_paise?: number;
  pickup_at?: string;
  return_due_at?: string;
}

function validationError(errors: Partial<Record<string, string>>): Response {
  return json({ error: 'Check the highlighted fields.', code: 'validation', hint: errors }, 422);
}

const toIso = (value: string | undefined) => (value ? new Date(value).toISOString() : null);

Deno.serve(
  handler('submit-booking', async (req) => {
    allowMethods(req, ['POST']);
    const body = await readJson(req);

    // Honeypot: bots fill the hidden field. Pretend it worked and save nothing.
    if (str(body.website) !== '') return json({ ok: true, booking_code: null });

    const service = serviceClient();
    const settings = await loadSettings(service, ['booking_rules', 'business']);

    // BK-06: every rule is checked again here.
    const check = validateBookingRequest(
      {
        car_id: str(body.car_id),
        package: str(body.package),
        pickup_date: str(body.pickup_date),
        pickup_time: str(body.pickup_time),
        full_name: typeof body.full_name === 'string' ? body.full_name : '',
        phone: str(body.phone),
        dl_number: str(body.dl_number),
        email: optStr(body.email),
        consent: body.consent === true,
      },
      { rules: settings.booking_rules, hours: settings.business.hours },
    );
    if (!check.ok) return validationError(check.errors);
    const value = check.value;
    const locale: Locale = (LOCALES as readonly string[]).includes(str(body.locale)) ? (str(body.locale) as Locale) : 'en';

    const ip = clientIp(req);
    const ua = userAgent(req);

    // BK-11: at most 5 per mobile number and 20 per IP address per hour.
    const { data: allowed, error: limitError } = await service.rpc('_register_submission', {
      p_kind: 'booking',
      p_phone: value.phone,
      p_ip_hash: await ipHash(ip),
      p_max_phone: 5,
      p_max_ip: 20,
    });
    if (limitError) throw fromPgError(limitError, 'submit-booking');
    if (allowed !== true) throw new HttpError(429, MESSAGES.tooManyRequests, 'rate_limited');

    const { data: noticeVersion, error: noticeError } = await service.rpc('current_notice_version', { p_locale: locale });
    if (noticeError) throw fromPgError(noticeError, 'submit-booking');

    const { data, error } = await service.rpc('_create_booking', {
      p_car_id: value.car_id,
      p_package: value.package,
      p_pickup_at: value.pickup_at.toISOString(),
      p_custom_hours: null,
      p_full_name: value.full_name,
      p_phone: value.phone,
      p_dl_number: value.dl_number,
      p_email: value.email,
      p_source: 'website',
      p_created_by: null,
      p_notice_version: noticeVersion,
      p_consent_channel: 'website',
      p_ip: ip,
      p_user_agent: ua,
      p_reject_on_clash: true,
      p_staff: false,
    });
    if (error) {
      // Field rules repeated in SQL come back with the field name as the machine code.
      if (error.code === 'P0001' && error.details && BOOKING_FIELDS.includes(error.details)) {
        return validationError({ [error.details]: error.message });
      }
      throw fromPgError(error, 'submit-booking');
    }

    const result = data as CreateBookingResult;
    if (!result?.ok) {
      if (result?.error === 'clash') {
        return json({
          ok: false,
          error: 'clash',
          message: result.message ?? MESSAGES.carClash,
          suggestions: result.suggestions ?? [],
        });
      }
      throw new HttpError(400, result?.message ?? GENERIC_ERROR, result?.error ?? 'invalid');
    }

    // The new-request email was enqueued by SQL; send it without delaying the customer.
    drainOutboxInBackground(service, 'submit-booking');

    return json({
      ok: true,
      booking_code: result.booking_code,
      pickup_at: toIso(result.pickup_at),
      return_due_at: toIso(result.return_due_at),
      price_paise: result.price_paise,
      phone: value.phone,
    });
  }),
);
