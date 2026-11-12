import { createHash } from "node:crypto";
import type { QueryFn } from "../db/index.js";

/** Ключ кешу: тенант + вид + нормалізований вхід + версія моделі (§10.6.1). */
export function cacheKey(input: { tenantId: string; kind: string; payload: unknown; model?: string; version?: string }): string {
  const norm = JSON.stringify(input.payload, Object.keys(input.payload ?? {}).sort());
  return createHash("sha256")
    .update([input.tenantId, input.kind, norm, input.model ?? "-", input.version ?? "1"].join("|"))
    .digest("hex");
}

export async function cacheGet<T = unknown>(q: QueryFn, key: string): Promise<T | null> {
  const { rows } = await q<any>(
    `UPDATE response_cache SET hits = hits + 1
     WHERE key=$1 AND expires_at > now() RETURNING payload`, [key]);
  return rows[0] ? (rows[0].payload as T) : null;
}

export async function cacheSet(q: QueryFn, input: { key: string; tenantId: string; kind: string; payload: unknown; ttlSeconds?: number }) {
  const ttl = Math.max(1, input.ttlSeconds ?? 3600);
  await q(
    `INSERT INTO response_cache (key, tenant_id, kind, payload, expires_at)
     VALUES ($1,$2,$3,$4::jsonb, now() + ($5 || ' seconds')::interval)
     ON CONFLICT (key) DO UPDATE SET payload=$4::jsonb, expires_at=now() + ($5 || ' seconds')::interval`,
    [input.key, input.tenantId, input.kind, JSON.stringify(input.payload), String(ttl)]);
}

export async function cacheStats(q: QueryFn) {
  const { rows } = await q<any>(
    `SELECT count(*)::int AS entries, coalesce(sum(hits),0)::int AS hits,
            count(*) FILTER (WHERE expires_at <= now())::int AS expired
     FROM response_cache`);
  return rows[0] ?? { entries: 0, hits: 0, expired: 0 };
}

export async function cachePurgeExpired(q: QueryFn): Promise<number> {
  const { rows } = await q<any>("DELETE FROM response_cache WHERE expires_at <= now() RETURNING key");
  return rows.length;
}
