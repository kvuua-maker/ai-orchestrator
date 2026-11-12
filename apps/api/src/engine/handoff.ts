import type { QueryFn } from "../db/index.js";
import { newId } from "../ids.js";
import type { DeadEndVerdict } from "./autonomy.js";

export interface HandoffRow {
  id: string; tenant_id: string; run_id: string; task_id: string | null;
  reason: string; question: string; options: Array<{ id: string; label: string }>;
  status: "pending" | "resolved" | "expired" | "cancelled";
  answer: string | null; answer_option: string | null;
  created_at: string; resolved_at: string | null; expires_at: string | null;
}

export async function createHandoff(
  q: QueryFn,
  input: { tenantId: string; runId: string; taskId?: string | null; verdict: DeadEndVerdict; ttlMinutes?: number },
): Promise<HandoffRow> {
  const id = newId.sec().replace("sec_", "hof_");
  const ttl = input.ttlMinutes ?? 24 * 60;
  const { rows } = await q<HandoffRow>(
    `INSERT INTO handoffs (id, tenant_id, run_id, task_id, reason, question, options, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb, now() + ($8 || ' minutes')::interval)
     RETURNING *`,
    [id, input.tenantId, input.runId, input.taskId ?? null, input.verdict.reason,
     input.verdict.question ?? input.verdict.message, JSON.stringify(input.verdict.options ?? []), String(ttl)],
  );
  return rows[0]!;
}

export async function getPendingHandoff(q: QueryFn, runId: string): Promise<HandoffRow | null> {
  const { rows } = await q<HandoffRow>(
    `SELECT * FROM handoffs WHERE run_id=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1`, [runId]);
  return rows[0] ?? null;
}

export async function getHandoff(q: QueryFn, id: string): Promise<HandoffRow | null> {
  const { rows } = await q<HandoffRow>("SELECT * FROM handoffs WHERE id=$1", [id]);
  return rows[0] ?? null;
}

/** Рішення людини. Тільки pending; ідемпотентно для вже вирішених. */
export async function resolveHandoff(
  q: QueryFn,
  id: string,
  input: { answer?: string; option?: string },
): Promise<{ ok: true; handoff: HandoffRow } | { ok: false; reason: string }> {
  const existing = await getHandoff(q, id);
  if (!existing) return { ok: false, reason: "not_found" };
  if (existing.status === "resolved") return { ok: true, handoff: existing };
  if (existing.status !== "pending") return { ok: false, reason: existing.status };

  const { rows } = await q<HandoffRow>(
    `UPDATE handoffs SET status='resolved', answer=$2, answer_option=$3, resolved_at=now()
     WHERE id=$1 AND status='pending' RETURNING *`,
    [id, input.answer ?? null, input.option ?? null],
  );
  return rows[0] ? { ok: true, handoff: rows[0] } : { ok: false, reason: "race" };
}

export async function expireStaleHandoffs(q: QueryFn): Promise<number> {
  const { rows } = await q<any>(
    "UPDATE handoffs SET status='expired' WHERE status='pending' AND expires_at IS NOT NULL AND expires_at <= now() RETURNING id");
  return rows.length;
}

export async function listHandoffs(q: QueryFn, opts: { status?: string; limit?: number } = {}) {
  const limit = Math.min(opts.limit ?? 20, 100);
  const { rows } = await q<HandoffRow>(
    `SELECT * FROM handoffs WHERE ($1::text IS NULL OR status=$1) ORDER BY created_at DESC LIMIT $2`,
    [opts.status ?? null, limit]);
  return rows;
}

export async function cancelHandoffsForRun(q: QueryFn, runId: string): Promise<number> {
  const { rows } = await q<any>(
    "UPDATE handoffs SET status='cancelled' WHERE run_id=$1 AND status='pending' RETURNING id", [runId]);
  return rows.length;
}
