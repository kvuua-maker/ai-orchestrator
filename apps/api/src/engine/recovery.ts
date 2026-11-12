import type { Db } from "../db/index.js";
import { appendEvent, setStatus } from "../repo/runs.js";
import { expireStaleHandoffs } from "./handoff.js";

export interface ReconcileResult { stalled: string[]; expiredHandoffs: number }

/**
 * Запуски, що «висять» у running/planning без heartbeat, переводяться в stalled (§21.4).
 * Ідемпотентно: повторний виклик нічого не змінює.
 */
export async function reconcileStalledRuns(
  db: Db,
  opts: { staleAfterMs?: number; tenantId?: string } = {},
): Promise<ReconcileResult> {
  const staleMs = opts.staleAfterMs ?? 10 * 60_000;
  const staleSeconds = Math.floor(staleMs / 1000);

  // З тенантом — tx під RLS. Без тенанта — лише сервісна роль (політика svc_all),
  // інакше RLS поверне нуль рядків і «завислі» запуски ніколи не знайдуться.
  const sql = `SELECT id, tenant_id FROM runs
     WHERE status IN ('queued','planning','running')
       AND last_heartbeat_at < now() - ($1 || ' seconds')::interval
     LIMIT 100`;
  const { rows } = opts.tenantId
    ? await db.tx(opts.tenantId, (q) => q<any>(sql, [String(staleSeconds)]))
    : await db.query<any>(sql, [String(staleSeconds)]);

  const stalled: string[] = [];
  let expiredHandoffs = 0;
  for (const r of rows) {
    await db.tx(r.tenant_id, async (q) => {
      await setStatus(q, r.id, "stalled", { error: "no heartbeat — reconciled" });
      await appendEvent(q, r.id, "run.stalled", { staleMs });
      expiredHandoffs += await expireStaleHandoffs(q);
    });
    stalled.push(r.id);
  }
  return { stalled, expiredHandoffs };
}
