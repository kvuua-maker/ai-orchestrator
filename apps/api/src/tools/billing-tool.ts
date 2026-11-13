import { z } from "zod";
import pg from "pg";
import { defineTool } from "./sdk.js";

/** billing.status — квоти й витрати поточного періоду (читає ту саму БД). */

let pool: pg.Pool | null = null;
function db(): pg.Pool {
  if (!pool) pool = new pg.Pool({ connectionString: process.env.EDR_DATABASE_URL ?? process.env.DATABASE_URL, max: 2, idleTimeoutMillis: 30_000 });
  return pool;
}

export const billingStatus = defineTool({
  name: "billing.status",
  version: "1.0.0",
  description:
    "Show the current plan, how many runs were used this month, the remaining quota and the spend in USD. " +
    "Use it when the user asks about limits, tariffs or how much they have left.",
  input: z.object({}),
  output: z.object({
    plan: z.string(), runsUsed: z.number(), runsLimit: z.number(), runsLeft: z.number(),
    spendUsd: z.number(), periodStart: z.string().nullable(),
  }),
  risk: "read", effectClass: "pure", costClass: "free",
  scopes: ["billing:read"], agents: ["synthesizer", "data"],
  timeoutMs: 8_000, maxRetries: 0,
  async execute(_input, ctx) {
    // RLS: без tenant-контексту запит бачить 0 рядків
    const client = await db().connect();
    let rows: any[] = [];
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [ctx.tenantId]);
      const res = await client.query(`
      SELECT p.name AS plan, p.monthly_runs AS runs_limit,
             (SELECT count(*) FROM runs WHERE created_at >= date_trunc('month', now())) AS runs_used,
             (SELECT coalesce(sum(spent_usd),0) FROM runs WHERE created_at >= date_trunc('month', now())) AS spend,
             date_trunc('month', now())::date::text AS period_start
        FROM subscriptions s JOIN plans p ON p.id = s.plan_id
       WHERE s.status = 'active'
       ORDER BY s.created_at DESC LIMIT 1`);
      rows = res.rows;
      await client.query("COMMIT");
    } catch {
      await client.query("ROLLBACK").catch(() => {});
      rows = [];
    } finally {
      client.release();
    }
    const r = rows[0] ?? {};
    const used = Number(r.runs_used ?? 0), limit = Number(r.runs_limit ?? 0);
    return {
      data: {
        plan: String(r.plan ?? "—"), runsUsed: used, runsLimit: limit,
        runsLeft: Math.max(0, limit - used), spendUsd: Math.round(Number(r.spend ?? 0) * 100) / 100,
        periodStart: r.period_start ?? null,
      },
    };
  },
  async simulate() {
    return { data: { plan: "dry-run", runsUsed: 0, runsLimit: 0, runsLeft: 0, spendUsd: 0, periodStart: null } };
  },
});
