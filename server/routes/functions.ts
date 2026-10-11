// The former Supabase edge functions, now /api/fn/<name> (same request/response contracts).
// CONTRACT STUB: submit-booking, document-upload, document-view-url, create-upload-link,
// customer-upload, retention-purge, admin-staff.
import { Hono } from 'hono';
import type { AppEnv } from '../http.ts';

export const functionRoutes = new Hono<AppEnv>();
