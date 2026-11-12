/**
 * Навантажувальний тест: N одночасних запусків через реальний HTTP.
 * Запуск: node scripts/load-test.mjs [N=100]
 */
import pg from "pg";

const N = Number(process.argv[2] ?? 100);
const BASE = process.env.API_URL ?? "http://127.0.0.1:4000";
const TENANT = "tnt_loadtest";
const H = { "content-type": "application/json", "x-tenant-id": TENANT };
const ADMIN = process.env.DATABASE_URL ?? "postgres://aio_app@127.0.0.1:6432/aio";

const pct = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.ceil((p / 100) * arr.length) - 1)] : 0;

const db = new pg.Client({ connectionString: ADMIN });
await db.connect();
await db.query("INSERT INTO tenants (id,name) VALUES ($1,'Load Test') ON CONFLICT DO NOTHING", [TENANT]);

// готуємо тенанта: бізнес-план (квота не має обмежувати вимір) і чистий облік
await db.query("BEGIN");
await db.query("SELECT set_config('app.tenant_id',$1,true)", [TENANT]);
await db.query("DELETE FROM runs WHERE tenant_id=$1", [TENANT]);
await db.query("DELETE FROM usage_events WHERE tenant_id=$1", [TENANT]);
await db.query(`INSERT INTO subscriptions (tenant_id, plan_id, status) VALUES ($1,'business','active')
                ON CONFLICT (tenant_id) DO UPDATE SET plan_id='business', status='active'`, [TENANT]);
await db.query("COMMIT");

const t0 = Date.now();
const results = await Promise.all(Array.from({ length: N }, async () => {
  const start = performance.now();
  try {
    const res = await fetch(`${BASE}/v1/runs`, {
      method: "POST", headers: H,
      body: JSON.stringify({ prompt: "Перевір https://example.com і зроби висновок" }),
    });
    const body = await res.json();
    return { ok: res.ok, status: res.status, ms: performance.now() - start, id: body?.run?.id, code: body?.error?.code };
  } catch (e) {
    return { ok: false, status: 0, ms: performance.now() - start, error: String(e.message) };
  }
}));
const acceptMs = Date.now() - t0;

// чекаємо завершення всіх запусків
let done = 0, failed = 0, polls = 0;
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500));
  polls++;
  await db.query("BEGIN");
  await db.query("SELECT set_config('app.tenant_id',$1,true)", [TENANT]);
  const r = await db.query(
    `SELECT count(*) FILTER (WHERE status='done')::int AS done,
            count(*) FILTER (WHERE status IN ('failed','stalled'))::int AS failed,
            count(*) FILTER (WHERE status IN ('queued','planning','running','blocked'))::int AS pending
     FROM runs WHERE tenant_id=$1`, [TENANT]);
  await db.query("COMMIT");
  done = r.rows[0].done; failed = r.rows[0].failed;
  if (r.rows[0].pending === 0) break;
}
const totalMs = Date.now() - t0;

const lat = results.filter((r) => r.ok).map((r) => Math.round(r.ms)).sort((a, b) => a - b);
const accepted = results.filter((r) => r.ok).length;
const rejected = results.filter((r) => !r.ok);

const mem = process.memoryUsage ? null : null;
const report = {
  concurrency: N,
  accepted,
  rejected: rejected.length,
  rejectionCodes: [...new Set(rejected.map((r) => r.code ?? r.status ?? r.error))],
  accept: { totalMs: acceptMs, p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), max: lat.at(-1) ?? 0 },
  completion: { done, failed, pending: N - done - failed, totalMs, throughputPerSec: Math.round((done / totalMs) * 1000 * 10) / 10 },
};
console.log(JSON.stringify(report, null, 2));
await db.end();
process.exit(rejected.length === 0 && failed === 0 ? 0 : 1);
