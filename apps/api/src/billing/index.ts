import type { QueryFn } from "../db/index.js";
import { newId } from "../ids.js";

export interface Plan {
  id: string; name: string; price_usd: string;
  monthly_runs: number; monthly_tokens: number; max_concurrent: number; overage_per_1k_tokens: string;
}

export interface UsageSummary {
  runs: number; tokens: number; costUsd: number;
  periodStart: string; periodEnd: string;
}

export interface QuotaState {
  plan: Plan;
  usage: UsageSummary;
  runsRemaining: number;
  tokensRemaining: number;
  allowed: boolean;
  reason?: "run_limit" | "token_limit" | "no_plan" | "suspended";
}

export async function listPlans(q: QueryFn): Promise<Plan[]> {
  const { rows } = await q<Plan>("SELECT * FROM plans ORDER BY price_usd");
  return rows;
}

export async function getSubscription(q: QueryFn, tenantId: string) {
  const { rows } = await q<any>(
    `SELECT s.*, p.name AS plan_name, p.price_usd, p.monthly_runs, p.monthly_tokens,
            p.max_concurrent, p.overage_per_1k_tokens
     FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.tenant_id = $1`, [tenantId]);
  return rows[0] ?? null;
}

export async function setPlan(q: QueryFn, tenantId: string, planId: string) {
  await q(
    `INSERT INTO subscriptions (tenant_id, plan_id, status, period_start, period_end)
     VALUES ($1,$2,'active', date_trunc('month', now()), date_trunc('month', now()) + interval '1 month')
     ON CONFLICT (tenant_id) DO UPDATE SET plan_id=$2, status='active'`, [tenantId, planId]);
  return getSubscription(q, tenantId);
}

/** Облік витрат: один рядок на подію, не агрегат — щоб можна було перевірити кожну (§19.2). */
export async function recordUsage(
  q: QueryFn,
  e: { tenantId: string; runId?: string | null; kind: "run" | "tokens" | "tool" | "storage"; quantity?: number; costUsd?: number; meta?: Record<string, unknown> },
): Promise<string> {
  const id = newId.run().replace("run_", "use_");
  await q(
    `INSERT INTO usage_events (id, tenant_id, run_id, kind, quantity, cost_usd, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [id, e.tenantId, e.runId ?? null, e.kind, Math.max(0, Math.round(e.quantity ?? 1)),
     Math.max(0, e.costUsd ?? 0), JSON.stringify(e.meta ?? {})]);
  return id;
}

export async function getUsage(q: QueryFn, tenantId: string): Promise<UsageSummary> {
  const { rows } = await q<any>(
    `SELECT coalesce(sum(quantity) FILTER (WHERE kind='run'),0)::int AS runs,
            coalesce(sum(quantity) FILTER (WHERE kind='tokens'),0)::bigint AS tokens,
            coalesce(sum(cost_usd),0)::float8 AS cost
     FROM usage_events
     WHERE tenant_id=$1 AND created_at >= date_trunc('month', now())`, [tenantId]);
  const r = rows[0] ?? { runs: 0, tokens: 0, cost: 0 };
  const { rows: per } = await q<any>(
    "SELECT date_trunc('month', now()) AS s, date_trunc('month', now()) + interval '1 month' AS e");
  return {
    runs: Number(r.runs), tokens: Number(r.tokens), costUsd: Math.round(Number(r.cost) * 1e6) / 1e6,
    periodStart: new Date(per[0].s).toISOString(), periodEnd: new Date(per[0].e).toISOString(),
  };
}

/** Стан квоти — читається перед створенням run і перед кожним кроком (§19.3). */
export async function getQuota(q: QueryFn, tenantId: string): Promise<QuotaState> {
  const sub = await getSubscription(q, tenantId);
  const usage = await getUsage(q, tenantId);
  if (!sub) {
    const { rows } = await q<Plan>("SELECT * FROM plans WHERE id='free'");
    const plan = rows[0]!;
    const runsRemaining = Math.max(0, plan.monthly_runs - usage.runs);
    const tokensRemaining = Math.max(0, plan.monthly_tokens - usage.tokens);
    return { plan, usage, runsRemaining, tokensRemaining,
      allowed: runsRemaining > 0 && tokensRemaining > 0,
      reason: runsRemaining <= 0 ? "run_limit" : tokensRemaining <= 0 ? "token_limit" : undefined };
  }
  if (sub.status !== "active") {
    return { plan: sub as Plan, usage, runsRemaining: 0, tokensRemaining: 0, allowed: false, reason: "suspended" };
  }
  const runsRemaining = Number(sub.monthly_runs) - usage.runs;
  const tokensRemaining = Number(sub.monthly_tokens) - usage.tokens;
  const allowed = runsRemaining > 0 && tokensRemaining > 0;
  const plan: Plan = {
    id: sub.plan_id, name: sub.plan_name, price_usd: String(sub.price_usd),
    monthly_runs: Number(sub.monthly_runs), monthly_tokens: Number(sub.monthly_tokens),
    max_concurrent: Number(sub.max_concurrent), overage_per_1k_tokens: String(sub.overage_per_1k_tokens),
  };
  return {
    plan, usage, runsRemaining: Math.max(0, runsRemaining), tokensRemaining: Math.max(0, tokensRemaining),
    allowed, reason: !allowed ? (runsRemaining <= 0 ? "run_limit" : "token_limit") : undefined,
  };
}

/** Інвойс за період: підписка + перевитрата токенів (§19.4). */
export async function createInvoice(q: QueryFn, tenantId: string, period?: { start: Date; end: Date }) {
  const sub = await getSubscription(q, tenantId);
  if (!sub) throw new Error("no subscription");
  const start = period?.start ?? new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const end = period?.end ?? new Date(start.getFullYear(), start.getMonth() + 1, 1);

  const { rows } = await q<any>(
    `SELECT coalesce(sum(quantity) FILTER (WHERE kind='run'),0)::int AS runs,
            coalesce(sum(quantity) FILTER (WHERE kind='tokens'),0)::bigint AS tokens,
            coalesce(sum(cost_usd),0)::float8 AS cost
     FROM usage_events WHERE tenant_id=$1 AND created_at >= $2 AND created_at < $3`,
    [tenantId, start.toISOString(), end.toISOString()]);

  const runs = Number(rows[0]?.runs ?? 0);
  const tokens = Number(rows[0]?.tokens ?? 0);
  const planPrice = Number(sub.price_usd);
  const includedTokens = Number(sub.monthly_tokens);
  const overageTokens = Math.max(0, tokens - includedTokens);
  const overageUsd = Math.round((overageTokens / 1000) * Number(sub.overage_per_1k_tokens) * 10000) / 10000;
  const amount = Math.round((planPrice + overageUsd) * 10000) / 10000;

  const lines = [
    { description: `Plan ${sub.plan_name}`, quantity: 1, unit_usd: planPrice, amount_usd: planPrice },
    ...(overageTokens > 0
      ? [{ description: `Token overage (${overageTokens} over ${includedTokens})`, quantity: Math.ceil(overageTokens / 1000),
           unit_usd: Number(sub.overage_per_1k_tokens), amount_usd: overageUsd }]
      : []),
  ];

  const id = newId.run().replace("run_", "inv_");
  await q(
    `INSERT INTO invoices (id, tenant_id, period_start, period_end, amount_usd, status, lines)
     VALUES ($1,$2,$3,$4,$5,'open',$6::jsonb)`,
    [id, tenantId, start.toISOString(), end.toISOString(), amount, JSON.stringify(lines)]);
  return { id, tenantId, periodStart: start, periodEnd: end, amountUsd: amount, status: "open", lines, usage: { runs, tokens } };
}

export async function listInvoices(q: QueryFn, tenantId: string, limit = 20) {
  const { rows } = await q<any>(
    "SELECT * FROM invoices WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2", [tenantId, limit]);
  return rows;
}
