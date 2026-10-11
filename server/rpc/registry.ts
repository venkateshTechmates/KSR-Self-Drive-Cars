// Business functions callable as POST /api/rpc/<name> with named p_* arguments: the same
// names and arguments as the Supabase SQL functions, so the web app calls them unchanged.
// Each call runs in one transaction (see server/routes/api.ts): an error rolls back everything.
import type { Ctx } from '../access/context.ts';

export type RpcArgs = Record<string, unknown>;
export type RpcHandler = (ctx: Ctx, args: RpcArgs) => unknown;

/** 'public': anyone, including visitors. 'user': any signed-in user (handlers check roles). */
export type RpcAccess = 'public' | 'user';

interface RpcDef {
  access: RpcAccess;
  handler: RpcHandler;
}

const registry = new Map<string, RpcDef>();

export function defineRpc(name: string, access: RpcAccess, handler: RpcHandler): void {
  if (registry.has(name)) throw new Error(`RPC ${name} defined twice`);
  registry.set(name, { access, handler });
}

export const getRpc = (name: string) => registry.get(name);
export const rpcNames = () => [...registry.keys()].sort();
