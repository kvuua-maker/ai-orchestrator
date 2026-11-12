import type { Db } from "../db/index.js";
import { newId } from "../ids.js";

export interface RunRow {
  id: string; tenant_id: string; user_id: string; status: string; prompt: string;
  goal_spec: unknown; plan: unknown; budget: unknown; spent_usd: string;
  result: unknown; error: string | null; dry_run: boolean; next_seq: number;
  created_at: string; updated_at: string; finished_at: string | null;
}

export async function insertRun(db: Db, r: {
  tenantId: string; userId: string; prompt: string; budget: unknown; dryRun: boolean;
}): Promise<RunRow> {
  const id = newId.run();
  const { rows } = await db.query<RunRow>(
    `INSERT INTO runs (id, tenant_id, user_id, status, prompt, budget, dry_run)
     VALUES ($1,$2,$3,'queued',$4,$5::jsonb,$6) RETURNING *`,
    [id, r.tenantId, r.userId, r.prompt, JSON.stringify(r.budget), r.dryRun],
  );
  return rows[0]!;
}

export async function getRun(db: Db, id: string, tenantId?: string): Promise<RunRow | undefined> {
  const { rows } = tenantId
    ? await db.query<RunRow>("SELECT * FROM runs WHERE id = $1 AND tenant_id = $2", [id, tenantId])
    : await db.query<RunRow>("SELECT * FROM runs WHERE id = $1", [id]);
  return rows[0];
}

export async function listRuns(db: Db, opts: { tenantId: string; limit: number; updatedSince?: string; cursor?: string }) {
  const params: unknown[] = [opts.tenantId];
  const where: string[] = ["tenant_id = $1"];
  if (opts.updatedSince) { params.push(opts.updatedSince); where.push(`updated_at > $${params.length}`); }
  if (opts.cursor) {
    const [ts, cid] = Buffer.from(opts.cursor, "base64url").toString().split("|");
    params.push(ts, cid); where.push(`(updated_at, id) < ($${params.length - 1}, $${params.length})`);
  }
  params.push(opts.limit + 1);
  const sql = `SELECT * FROM runs WHERE ${where.join(" AND ")}
               ORDER BY updated_at DESC, id DESC LIMIT $${params.length}`;
  const { rows } = await db.query<RunRow>(sql, params);
  const hasMore = rows.length > opts.limit;
  const items = hasMore ? rows.slice(0, opts.limit) : rows;
  const last = items.at(-1);
  const next = hasMore && last ? Buffer.from(`${new Date(last.updated_at).toISOString()}|${last.id}`).toString("base64url") : null;
  return { items, hasMore, next };
}

export async function setStatus(db: Db, id: string, status: string, extra: { error?: string; result?: unknown } = {}) {
  const terminal = ["done", "failed", "cancelled", "blocked"].includes(status);
  await db.query(
    `UPDATE runs SET status=$2, updated_at=now(), error=COALESCE($3, error),
       result=COALESCE($4::jsonb, result), finished_at=CASE WHEN $5 THEN now() ELSE finished_at END
     WHERE id=$1`,
    [id, status, extra.error ?? null, extra.result !== undefined ? JSON.stringify(extra.result) : null, terminal],
  );
}

/** Атомарний seq для події + вставка (§35.2). */
export async function appendEvent(db: Db, runId: string, type: string, payload: Record<string, unknown> = {}) {
  const { rows } = await db.query<{ next_seq: number }>(
    "UPDATE runs SET next_seq = next_seq + 1, updated_at = now() WHERE id=$1 RETURNING next_seq", [runId],
  );
  const seq = rows[0]!.next_seq;
  await db.query(
    "INSERT INTO run_events (run_id, seq, type, payload) VALUES ($1,$2,$3,$4::jsonb)",
    [runId, seq, type, JSON.stringify(payload)],
  );
  return seq;
}

export async function getEvents(db: Db, runId: string, since = 0) {
  const { rows } = await db.query(
    "SELECT seq, type, payload, created_at FROM run_events WHERE run_id=$1 AND seq>$2 ORDER BY seq ASC LIMIT 500",
    [runId, since],
  );
  return rows;
}

export async function insertTasks(db: Db, runId: string, nodes: Array<{ id: string; agent: string; goal: string; estCostUsd: number }>) {
  for (const n of nodes) {
    await db.query("INSERT INTO tasks (id, run_id, agent, goal, est_cost_usd) VALUES ($1,$2,$3,$4,$5)",
      [n.id, runId, n.agent, n.goal, n.estCostUsd]);
  }
}

export async function updateTask(db: Db, taskId: string, status: string) {
  await db.query(`UPDATE tasks SET status=$2, started_at=COALESCE(started_at, CASE WHEN $2='running' THEN now() END),
    finished_at=CASE WHEN $2 IN ('done','failed','skipped') THEN now() ELSE finished_at END WHERE id=$1`, [taskId, status]);
}
