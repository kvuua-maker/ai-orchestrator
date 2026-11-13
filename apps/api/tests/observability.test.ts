import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/app.js";
import { Metrics } from "../src/observability/metrics.js";

const H = { "x-tenant-id": "tnt_demo0001" };
const B = { "x-tenant-id": "tnt_other001" };

describe("Metrics (unit)", () => {
  it("лічильники з мітками", () => {
    const m = new Metrics();
    m.inc("req", { route: "/a", status: 200 });
    m.inc("req", { route: "/a", status: 200 });
    m.inc("req", { route: "/b", status: 500 });
    expect(m.snapshot().counters['req{route="/a",status="200"}']).toBe(2);
  });
  it("перцентилі гістограми", () => {
    const m = new Metrics();
    for (const v of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) m.observe("dur", v);
    const h = m.histogram()[0]!;
    expect(h.count).toBe(10);
    expect(h.p50).toBe(50);
    expect(h.p95).toBe(100);
    expect(h.max).toBe(100);
  });
  it("обмежує кількість семплів", () => {
    const m = new Metrics(5);
    for (let i = 0; i < 100; i++) m.observe("x", i);
    expect(m.histogram()[0]!.count).toBe(5);
  });
  it("prometheus-формат", () => {
    const m = new Metrics();
    m.inc("aio_runs_total", { status: "done" });
    const text = m.prometheus();
    expect(text).toContain('aio_runs_total{status="done"} 1');
    expect(text).toContain("# TYPE aio_runs_total counter");
  });
});

describe("Observability API", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => { app = await buildApp(); await app.ready(); });
  afterAll(async () => { await app.close(); });

  it("кожна відповідь має x-trace-id", async () => {
    const r = await app.inject({ method: "GET", url: "/healthz" });
    expect(r.headers["x-trace-id"]).toMatch(/^tr_[a-f0-9]{24}$/);
  });

  it("вхідний trace-id зберігається", async () => {
    const r = await app.inject({ method: "GET", url: "/healthz", headers: { "x-trace-id": "tr_0123456789abcdef01234567" } });
    expect(r.headers["x-trace-id"]).toBe("tr_0123456789abcdef01234567");
  });

  it("сміттєвий trace-id замінюється", async () => {
    const r = await app.inject({ method: "GET", url: "/healthz", headers: { "x-trace-id": "hack" } });
    expect(r.headers["x-trace-id"]).toMatch(/^tr_[a-f0-9]{24}$/);
  });

  it("GET /metrics віддає Prometheus-текст", async () => {
    await app.inject({ method: "GET", url: "/healthz" });
    const r = await app.inject({ method: "GET", url: "/metrics" });
    expect(r.headers["content-type"]).toContain("text/plain");
    expect(r.body).toContain("aio_http_requests_total");
  });

  it("summary містить ключові показники", async () => {
    await app.inject({ method: "POST", url: "/v1/runs", headers: H, payload: { prompt: "тест метрик" } });
    await app.engine.drain();
    const r = await app.inject({ method: "GET", url: "/v1/observability/summary?hours=24", headers: H });
    const b = r.json();
    expect(b.runs.total).toBeGreaterThan(0);
    expect(b.success_rate).toBeGreaterThan(0);
    expect(b.duration_ms.p50).toBeGreaterThanOrEqual(0);
    expect(b.process.counters).toBeTruthy();
  });

  it("summary не протікає між тенантами", async () => {
    // API рахує запуски за вікном (типово 24 год) — порівнюємо в тому ж вікні,
    // інакше тест ламається, щойно в базі з'являються старіші запуски
    const own = await app.db.tx("tnt_other001", (q) => q<any>(
      "SELECT count(*)::int AS n FROM runs WHERE created_at > now() - interval '24 hours'"));
    const r = await app.inject({ method: "GET", url: "/v1/observability/summary", headers: { "x-tenant-id": "tnt_other001" } });
    expect(r.json().runs.total).toBe(own.rows[0].n);   // рівно свої, без чужих
  });
});

describe("Audit log", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => { app = await buildApp(); await app.ready(); });
  afterAll(async () => { await app.close(); });

  it("створення run пише аудит", async () => {
    const created = await app.inject({ method: "POST", url: "/v1/runs", headers: H, payload: { prompt: "аудит" } });
    const id = created.json().run.id;
    await app.engine.drain();
    const a = await app.inject({ method: "GET", url: "/v1/audit?action=run.created", headers: H });
    const items = a.json().items;
    expect(items.find((i: any) => i.resource_id === id)).toBeTruthy();
    expect(items[0].trace_id).toMatch(/^tr_/);
  });

  it("секрет пише аудит без значення", async () => {
    await app.inject({ method: "POST", url: "/v1/secrets", headers: H, payload: { kind: "api_key", label: "test", value: "super-secret-value" } });
    const a = await app.inject({ method: "GET", url: "/v1/audit?action=secret.created", headers: H });
    const raw = JSON.stringify(a.json());
    expect(raw).not.toContain("super-secret-value");
    expect(a.json().items.length).toBeGreaterThan(0);
  });

  it("чужий тенант не бачить аудит", async () => {
    const created = await app.inject({ method: "POST", url: "/v1/runs", headers: H, payload: { prompt: "приватний аудит" } });
    const id = created.json().run.id;
    const mine = await app.inject({ method: "GET", url: `/v1/audit?resourceId=${id}`, headers: H });
    expect(mine.json().items.length).toBe(1);
    const theirs = await app.inject({ method: "GET", url: `/v1/audit?resourceId=${id}`, headers: B });
    expect(theirs.json().items).toHaveLength(0);   // той самий ресурс, інший тенант
  });

  it("аудит append-only: UPDATE заборонено грантами", async () => {
    await expect(
      app.db.tx("tnt_demo0001", (q) => q("UPDATE audit_log SET action='hacked'")),
    ).rejects.toThrow();
  });
});

const HAS_SVC = !!process.env.SERVICE_DATABASE_URL;

describe.skipIf(!HAS_SVC)("Сервісна роль", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => { app = await buildApp(); await app.ready(); });
  afterAll(async () => { await app.close(); });

  it("reconcile з allTenants бачить запуски різних тенантів", async () => {
    const a = await app.inject({ method: "POST", url: "/v1/runs", headers: H, payload: { prompt: "stale-1" } });
    const b = await app.inject({ method: "POST", url: "/v1/runs", headers: B, payload: { prompt: "stale-2" } });
    const ida = a.json().run.id, idb = b.json().run.id;
    await app.engine.drain();
    for (const [tenant, id] of [["tnt_demo0001", ida], ["tnt_other001", idb]] as const) {
      await app.db.tx(tenant, (q) => q("UPDATE runs SET status='running', last_heartbeat_at=now() - interval '2 hours' WHERE id=$1", [id]));
    }
    const r = await app.inject({ method: "POST", url: "/v1/runs/reconcile", headers: H, payload: { allTenants: true, staleAfterMs: 60_000 } });
    expect(r.statusCode).toBe(200);
    const stalled = r.json().stalled;
    expect(stalled).toContain(ida);
    expect(stalled).toContain(idb);
  });
});
