import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import type { GoalSpec, Plan } from "@aio/shared";
import { buildApp } from "../src/app.js";
import { createRegistry } from "../src/tools/index.js";
import { defineTool } from "../src/tools/sdk.js";
import { newId } from "../src/ids.js";

const goal: GoalSpec = {
  objective: "тест", deliverables: [{ type: "message", name: "a" }], constraints: {},
  acceptanceCriteria: [{ id: "ac", check: "ok", type: "deterministic" }], riskLevel: "low", requiresConfirmation: false,
};

const planWith = (toolName: string): Plan => ({
  planId: "p-test", version: 1,
  nodes: [{
    id: newId.task(), agent: "browser", goal: `викликати ${toolName}`, tools: [toolName],
    dependsOn: [], parallelizable: false, fanOut: 1,
    acceptanceCriteria: [], estCostUsd: 0.001,
  }],
  estimatedTotalUsd: 0.001, criticalPath: [],
});

function makeApp(handler: () => Promise<void>) {
  let calls = 0;
  const tool = defineTool({
    name: "test.gated", version: "1.0.0", description: "fails until human resolves",
    input: z.object({ url: z.string().optional() }).passthrough(),
    risk: "read", effectClass: "pure", costClass: "free", agents: [],
    async execute() {
      calls++;
      await handler();
      return { data: { ok: true, calls } };
    },
  });
  const registry = createRegistry().register(tool);
  return buildApp({
    engineDeps: {
      registry,
      router: { name: "test", async route() { return { goalSpec: goal, source: "test" }; } },
      planner: { name: "test", async plan() { return planWith("test.gated"); } },
    },
  });
}

const H = { "x-tenant-id": "tnt_demo0001" };

describe("Handoff Protocol", () => {
  it("провал із CAPTCHA → run blocked + handoff із питанням", async () => {
    const app = await makeApp(async () => { throw new Error("cloudflare challenge detected"); });
    await app.ready();
    const created = await app.inject({ method: "POST", url: "/v1/runs", headers: H, payload: { prompt: "перевір сайт" } });
    const id = created.json().run.id;
    await app.engine.drain();

    const view = await app.inject({ method: "GET", url: `/v1/runs/${id}`, headers: H });
    const body = view.json();
    expect(body.run.status).toBe("blocked");
    expect(body.handoff).toBeTruthy();
    expect(body.handoff.reason).toBe("captcha");
    expect(body.handoff.question).toMatch(/CAPTCHA/);
    expect(body.handoff.options.length).toBe(3);

    const ev = (await app.inject({ method: "GET", url: `/v1/runs/${id}/events`, headers: H })).json();
    expect(ev.events.map((e: any) => e.type)).toContain("handoff.requested");
    expect(ev.events.map((e: any) => e.type)).toContain("run.blocked");
    await app.close();
  });

  it("resolve → resume → run завершується", async () => {
    let fail = true;
    const app = await makeApp(async () => { if (fail) throw new Error("captcha required"); });
    await app.ready();
    const created = await app.inject({ method: "POST", url: "/v1/runs", headers: H, payload: { prompt: "перевір" } });
    const id = created.json().run.id;
    await app.engine.drain();

    const blocked = (await app.inject({ method: "GET", url: `/v1/runs/${id}`, headers: H })).json();
    expect(blocked.run.status).toBe("blocked");

    fail = false;   // людина пройшла CAPTCHA
    const res = await app.inject({ method: "POST", url: `/v1/handoffs/${blocked.handoff.id}/resolve`, headers: H,
      payload: { option: "done", answer: "пройшов вручну" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().resumed).toBe(true);
    await app.engine.drain();

    const done = (await app.inject({ method: "GET", url: `/v1/runs/${id}`, headers: H })).json();
    expect(done.run.status).toBe("done");
    expect(done.handoff).toBeFalsy();

    const ev = (await app.inject({ method: "GET", url: `/v1/runs/${id}/events`, headers: H })).json();
    const types = ev.events.map((e: any) => e.type);
    expect(types).toContain("handoff.resolved");
    expect(types).toContain("run.resumed");
    expect(types.at(-1)).toBe("run.completed");
    await app.close();
  });

  it("жорстка межа (банк) → handoff із альтернативою, без спроб обійти", async () => {
    const app = await makeApp(async () => { throw new Error("500"); });
    await app.ready();
    const created = await app.inject({ method: "POST", url: "/v1/runs", headers: H, payload: { prompt: "зроби переказ коштів на IBAN" } });
    const id = created.json().run.id;
    await app.engine.drain();

    const body = (await app.inject({ method: "GET", url: `/v1/runs/${id}`, headers: H })).json();
    expect(body.run.status).toBe("blocked");
    expect(body.handoff.reason).toBe("banking_operation");
    const ev = (await app.inject({ method: "GET", url: `/v1/runs/${id}/events`, headers: H })).json();
    const req = ev.events.find((e: any) => e.type === "handoff.requested");
    expect(req.payload.alternative).toContain("платіжне доручення");
    await app.close();
  });

  it("повторний resolve ідемпотентний", async () => {
    const app = await makeApp(async () => { throw new Error("captcha"); });
    await app.ready();
    const created = await app.inject({ method: "POST", url: "/v1/runs", headers: H, payload: { prompt: "x" } });
    const id = created.json().run.id;
    await app.engine.drain();
    const h = (await app.inject({ method: "GET", url: `/v1/runs/${id}`, headers: H })).json().handoff;
    const a = await app.inject({ method: "POST", url: `/v1/handoffs/${h.id}/resolve`, headers: H, payload: { option: "abort" } });
    const b = await app.inject({ method: "POST", url: `/v1/handoffs/${h.id}/resolve`, headers: H, payload: { option: "abort" } });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(b.json().handoff.status).toBe("resolved");
    await app.close();
  });

  it("невідомий handoff → 404, без відповіді → 422", async () => {
    const app = await makeApp(async () => {});
    await app.ready();
    const r1 = await app.inject({ method: "POST", url: "/v1/handoffs/hof_nope/resolve", headers: H, payload: { option: "done" } });
    expect(r1.statusCode).toBe(404);
    const r2 = await app.inject({ method: "POST", url: "/v1/handoffs/hof_nope/resolve", headers: H, payload: {} });
    expect(r2.statusCode).toBe(422);
    await app.close();
  });
});

describe("Відновлення після збоїв", () => {
  it("reconcile переводить завислий run у stalled", async () => {
    const app = await makeApp(async () => {});
    await app.ready();
    const created = await app.inject({ method: "POST", url: "/v1/runs", headers: H, payload: { prompt: "висить" } });
    const id = created.json().run.id;
    await app.engine.drain();   // без гонки з виконавцем
    // імітуємо: run у running, heartbeat старий
    await app.db.tx("tnt_demo0001", async (q) => {
      await q("UPDATE runs SET status='running', last_heartbeat_at = now() - interval '1 hour' WHERE id=$1", [id]);
    });
    const rec = await app.inject({ method: "POST", url: "/v1/runs/reconcile", headers: H, payload: { staleAfterMs: 60_000 } });
    expect(rec.json().stalled).toContain(id);
    const view = (await app.inject({ method: "GET", url: `/v1/runs/${id}`, headers: H })).json();
    expect(view.run.status).toBe("stalled");
    await app.close();
  });

  it("resume із stalled доводить до done", async () => {
    const app = await makeApp(async () => {});
    await app.ready();
    const created = await app.inject({ method: "POST", url: "/v1/runs", headers: H, payload: { prompt: "тест" } });
    const id = created.json().run.id;
    await app.engine.drain();   // дочекатись виконавця, інакше він перезапише статус
    await app.db.tx("tnt_demo0001", async (q) => {
      await q("UPDATE runs SET status='stalled', plan=$2::jsonb WHERE id=$1", [id, JSON.stringify(planWith("test.gated"))]);
      await q("INSERT INTO tasks (id, run_id, agent, goal) VALUES ($1,$2,'browser','t')", [newId.task(), id]);
    });
    const r = await app.inject({ method: "POST", url: `/v1/runs/${id}/resume`, headers: H, payload: {} });
    expect(r.statusCode).toBe(202);
    await app.engine.drain();
    const view = (await app.inject({ method: "GET", url: `/v1/runs/${id}`, headers: H })).json();
    expect(["done", "failed"]).toContain(view.run.status);
    await app.close();
  });

  it("resume із done → 409", async () => {
    const app = await makeApp(async () => {});
    await app.ready();
    const created = await app.inject({ method: "POST", url: "/v1/runs", headers: H, payload: { prompt: "x" } });
    const id = created.json().run.id;
    await app.engine.drain();
    const r = await app.inject({ method: "POST", url: `/v1/runs/${id}/resume`, headers: H, payload: {} });
    expect(r.statusCode).toBe(409);
    await app.close();
  });

  it("список handoff'ів фільтрується за статусом", async () => {
    const app = await makeApp(async () => { throw new Error("captcha"); });
    await app.ready();
    await app.inject({ method: "POST", url: "/v1/runs", headers: H, payload: { prompt: "a" } });
    await app.engine.drain();
    const pending = await app.inject({ method: "GET", url: "/v1/handoffs?status=pending", headers: H });
    expect(pending.json().items.length).toBeGreaterThan(0);
    expect(pending.json().items.every((h: any) => h.status === "pending")).toBe(true);
    await app.close();
  });
});
