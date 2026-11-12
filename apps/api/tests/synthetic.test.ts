import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/app.js";

let app: Awaited<ReturnType<typeof buildApp>>;
const A = { "x-tenant-id": "tnt_demo0001" };
const B = { "x-tenant-id": "tnt_other001" };

beforeAll(async () => { app = await buildApp(); await app.ready(); });
afterAll(async () => { await app.close(); });

async function createRun(prompt: string, headers: Record<string,string> = A, idem?: string) {
  const h = idem ? { ...headers, "idempotency-key": idem } : headers;
  return app.inject({ method: "POST", url: "/v1/runs", headers: h, payload: { prompt } });
}

describe("synthetic tenant — 10 сценаріїв", () => {
  it("1. створення run → 201, статус queued", async () => {
    const r = await createRun("Зроби простий звіт");
    expect(r.statusCode).toBe(201);
    const b = r.json();
    expect(b.run.id).toMatch(/^run_/);
    expect(["queued", "planning", "running"]).toContain(b.run.status);
  });

  it("2. повний цикл: події в правильному порядку", async () => {
    const r = await createRun("Перевір https://example.com і зроби висновок");
    const id = r.json().run.id;
    await app.engine.drain();
    const run = (await app.inject({ method: "GET", url: `/v1/runs/${id}`, headers: A })).json();
    expect(run.run.status).toBe("done");
    expect(run.run.result).toBeTruthy();
    const ev = (await app.inject({ method: "GET", url: `/v1/runs/${id}/events`, headers: A })).json();
    const types = ev.events.map((e: any) => e.type);
    expect(types[0]).toBe("run.created");
    expect(types).toContain("plan.created");
    expect(types).toContain("task.started");
    expect(types.at(-1)).toBe("run.completed");
    expect(ev.last_seq).toBeGreaterThan(0);
  });

  it("3. ідемпотентність: два POST з одним ключем → один run", async () => {
    const key = "idem-test-001";
    const a = await createRun("Однакова задача", A, key);
    const b = await createRun("Однакова задача", A, key);
    expect(a.json().run.id).toBe(b.json().run.id);
    expect(b.json().replayed).toBe(true);
  });

  it("4. delta sync: updated_since повертає лише нові", async () => {
    const first = (await app.inject({ method: "GET", url: "/v1/runs", headers: A })).json();
    const ts = first.server_time;
    await createRun("Свіжий запуск");
    const delta = (await app.inject({ method: "GET", url: `/v1/runs?updated_since=${encodeURIComponent(ts)}`, headers: A })).json();
    expect(delta.items.length).toBeGreaterThanOrEqual(1);
    expect(delta.server_time).toBeTruthy();
  });

  it("5. пагінація: cursor віддає наступну сторінку без дублів", async () => {
    for (let i = 0; i < 3; i++) await createRun(`Пачка ${i}`);
    const p1 = (await app.inject({ method: "GET", url: "/v1/runs?limit=2", headers: A })).json();
    expect(p1.items.length).toBe(2);
    expect(p1.has_more).toBe(true);
    const p2 = (await app.inject({ method: "GET", url: `/v1/runs?limit=2&cursor=${p1.next_cursor}`, headers: A })).json();
    const ids1 = p1.items.map((i: any) => i.id);
    const ids2 = p2.items.map((i: any) => i.id);
    expect(ids1.filter((id: string) => ids2.includes(id))).toHaveLength(0);
  });

  it("6. невідомий run → 404 з кодом", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/runs/run_doesnotexist", headers: A });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe("NOT_FOUND");
  });

  it("7. SSE-стрім віддає події та завершується", async () => {
    const r = await createRun("Стрім");
    const id = r.json().run.id;
    await app.engine.drain();
    const res = await app.inject({ method: "GET", url: `/v1/runs/${id}/stream`, headers: A });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain("event:");
    expect(res.body).toContain("event: end");
  });

  it("8. cancel: 404 для невідомого, ідемпотентний для завершеного", async () => {
    const bad = await app.inject({ method: "POST", url: "/v1/runs/run_nope12345/cancel", headers: A, payload: {} });
    expect(bad.statusCode).toBe(404);

    const r = await createRun("Скасування");
    const id = r.json().run.id;
    await app.engine.drain();
    const c = await app.inject({ method: "POST", url: `/v1/runs/${id}/cancel`, headers: A, payload: { mode: "soft" } });
    expect(c.statusCode).toBe(200);
    expect(["done", "cancelled"]).toContain(c.json().run.status);
  });

  it("9. RLS: тенант B не бачить run тенанта A", async () => {
    const r = await createRun("Приватна задача A", A);
    const id = r.json().run.id;
    const asB = await app.inject({ method: "GET", url: `/v1/runs/${id}`, headers: B });
    expect(asB.statusCode).toBe(404);
    const listB = (await app.inject({ method: "GET", url: "/v1/runs", headers: B })).json();
    expect(listB.items.find((i: any) => i.id === id)).toBeUndefined();
  });

  it("10. presign → complete → artifact; device registration", async () => {
    const pre = await app.inject({ method: "POST", url: "/v1/uploads/presign", headers: A,
      payload: { filename: "receipt.pdf", mime: "application/pdf", sizeBytes: 6 * 1024 * 1024 } });
    expect(pre.statusCode).toBe(201);
    const p = pre.json();
    expect(p.parts.length).toBe(2);
    const done = await app.inject({ method: "POST", url: `/v1/uploads/${p.uploadId}/complete`, headers: A,
      payload: { parts: p.parts.map((x: any) => ({ partNumber: x.partNumber, etag: "e" })) } });
    expect(done.statusCode).toBe(200);
    expect(done.json().artifact.key).toContain("receipt.pdf");

    const dev = await app.inject({ method: "POST", url: "/v1/devices", headers: A,
      payload: { platform: "ios", apnsToken: "a".repeat(64), appVersion: "0.1.0" } });
    expect(dev.statusCode).toBe(201);
    expect(dev.json().deviceId).toMatch(/^dev_/);
  });
});
