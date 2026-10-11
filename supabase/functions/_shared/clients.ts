// Supabase clients and caller identity.
//   serviceClient()  – service role, bypasses RLS. Use only after checking the caller.
//   userClient(req)  – acts as the caller (their JWT), so RLS and auth.uid() apply in RPCs.
//   requireUser(req) – validates the caller's JWT and loads my_access().
// The only import of supabase-js; pinned inline so each function deploys without an import map.
// deno-lint-ignore no-import-prefix
import { type AuthError, createClient, type SupabaseClient, type User } from 'npm:@supabase/supabase-js@2';
import type { AppRole } from './domain/constants.ts';
import { bearerToken } from './auth.ts';
import { env, requireEnv } from './env.ts';
import { fromPgError, HttpError } from './http.ts';

export type Client = SupabaseClient;
export type { AuthError };

// Implicit flow: invite and password-reset links must work in another browser (no PKCE verifier).
const clientOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: 'implicit' },
} as const;

let service: Client | null = null;

export function serviceClient(): Client {
  if (!service) {
    service = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), clientOptions);
  }
  return service;
}

function clientForToken(token: string): Client {
  return createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_ANON_KEY'), {
    ...clientOptions,
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

/** Client that runs queries and RPCs as the caller (their Authorization header). */
export function userClient(req: Request): Client {
  const token = bearerToken(req);
  if (!token) throw new HttpError(401, 'Sign in to continue.', 'unauthorized');
  return clientForToken(token);
}

/** Result of public.my_access(). */
export interface Access {
  user_id: string | null;
  role: AppRole | null;
  /** Null until an Owner/Manager has completed two-step verification (aal2), or if inactive. */
  effective_role: AppRole | null;
  mfa_required: boolean;
  aal: string;
  full_name: string | null;
  active: boolean;
  security: unknown;
}

export interface UserContext {
  user: User;
  token: string;
  client: Client;
  access: Access;
}

/** Validate the caller's JWT and load their access. Throws 401 when not signed in. */
export async function requireUser(req: Request): Promise<UserContext> {
  const token = bearerToken(req);
  // The publishable / anon key is sent by signed-out browsers; it is not a user.
  if (!token || token === env('SUPABASE_ANON_KEY') || token.startsWith('sb_publishable_')) {
    throw new HttpError(401, 'Sign in to continue.', 'unauthorized');
  }
  const { data, error } = await serviceClient().auth.getUser(token);
  if (error || !data?.user) {
    throw new HttpError(401, 'Your session has ended. Sign in again.', 'unauthorized');
  }
  const client = clientForToken(token);
  const { data: access, error: accessError } = await client.rpc('my_access');
  if (accessError) throw fromPgError(accessError, 'my_access');
  return { user: data.user, token, client, access: access as Access };
}

/**
 * Require an effective admin role (two-step verification done where required).
 * Returns the role. Pass `roles` to restrict further.
 */
export function requireRole(ctx: UserContext, roles?: readonly AppRole[]): AppRole {
  const role = ctx.access.effective_role;
  if (!role) {
    if (ctx.access.role && ctx.access.active && ctx.access.mfa_required && ctx.access.aal !== 'aal2') {
      throw new HttpError(403, 'Complete two-step verification to continue.', 'mfa_required');
    }
    throw new HttpError(403, 'Not allowed.', 'forbidden');
  }
  if (roles && !roles.includes(role)) throw new HttpError(403, 'Not allowed.', 'forbidden');
  return role;
}
