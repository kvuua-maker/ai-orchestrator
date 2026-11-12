import type { QueryFn } from "../db/index.js";
import { newId } from "../ids.js";

export interface AuditEntry {
  tenantId: string;
  actorType: "user" | "agent" | "system";
  actorId?: string | null;
  action: string;
  resource: string;
  resourceId?: string | null;
  traceId?: string | null;
  ip?: string | null;
  meta?: Record<string, unknown>;
}

/** Append-only: UPDATE/DELETE відкликані на рівні грантів (§22.4). */
export async function writeAudit(q: QueryFn, e: AuditEntry): Promise<string> {
  const id = newId.run().replace("run_", "aud_");
  await q(
    `INSERT INTO audit_log (id, tenant_id, actor_type, actor_id, action, resource, resource_id, trace_id, ip, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
    [id, e.tenantId, e.actorType, e.actorId ?? null, e.action, e.resource,
     e.resourceId ?? null, e.traceId ?? null, e.ip ?? null, JSON.stringify(e.meta ?? {})],
  );
  return id;
}

export async function listAudit(q: QueryFn, opts: { action?: string; limit?: number; resourceId?: string } = {}) {
  const limit = Math.min(opts.limit ?? 50, 200);
  const { rows } = await q<any>(
    `SELECT id, actor_type, actor_id, action, resource, resource_id, trace_id, ip, meta, created_at
     FROM audit_log
     WHERE ($1::text IS NULL OR action=$1) AND ($2::text IS NULL OR resource_id=$2)
     ORDER BY created_at DESC LIMIT $3`,
    [opts.action ?? null, opts.resourceId ?? null, limit]);
  return rows;
}
