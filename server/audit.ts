// Audit log (6.13). Entries are insert-only; triggers in schema.sql refuse updates and deletes.
import type { Ctx } from './access/context.ts';
import { nowIso, run, scalar, uuid } from './db/connection.ts';

export function writeAudit(
  ctx: Ctx,
  action: string,
  entityType: string,
  entityId: string | null,
  before: unknown = null,
  after: unknown = null,
  opts: { actorId?: string | null; ip?: string | null; ua?: string | null } = {},
): void {
  const actor = opts.actorId !== undefined ? opts.actorId : ctx.userId;
  const role = actor ? (scalar<string>('SELECT role FROM user_roles WHERE user_id = ?', actor) ?? null) : null;
  const at = nowIso();
  run(
    `INSERT INTO audit_logs (id, actor_id, actor_role, action, entity_type, entity_id, before, after, ip, user_agent, at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    uuid(),
    actor,
    role,
    action,
    entityType,
    entityId,
    before === null || before === undefined ? null : JSON.stringify(before),
    after === null || after === undefined ? null : JSON.stringify(after),
    opts.ip !== undefined ? opts.ip : ctx.ip,
    (opts.ua !== undefined ? opts.ua : ctx.ua)?.slice(0, 400) ?? null,
    at,
    at,
    at,
  );
}
