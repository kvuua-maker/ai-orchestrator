import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { buildApp } from "../src/app.js";
import { createPlanner } from "../src/engine/llm-planner.js";

let srv: Server, port = 0;
const PLAN_JSON = JSON.stringify({
  nodes: [
    { agent: "browser", goal: "Відкрити сторінку", tools: ["http.fetch"], dependsOn: [], estCostUsd: 0.001 },
    { agent: "writer", goal: "Написати висновок", tools: [], dependsOn: [], estCostUsd: 0.002 },
  ],
});

beforeAll(async () => {
  srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const ok = req.url?.includes("/chat/completions");
      res.writeHead(ok ? 200 : 500, { "content-type": "application/json" });
      res.end(ok
        ? JSON.stringify({ choices: [{ message: { content: PLAN_JSON } }] })
        : JSON.stringify({ error: "boom" }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  port = (srv.address() as any).port;
});
afterAll(async () => { await new Promise<void>((r) => srv.close(() => r())); });

describe("Planner (DeepSeek + fallback)", () => {
  it("без ключа — евристичний план", async () => {
    const p = createPlanner({ apiKey: "" });
    expect(p.name).toBe("heuristic");
    const plan = await p.plan({ prompt: "зроби щось" });
    expect(plan.nodes.length).toBeGreaterThan(0);
  });

  it("з ключем — план приходить від моделі", async () => {
    const p = createPlanner({ apiKey: "k", baseUrl: `http://127.0.0.1:${port}` });
    expect(p.name).toBe("deepseek");
    const plan = await p.plan({ prompt: "Відкрий сайт і зроби висновок" });
    expect(plan.nodes.map((n) => n.agent)).toEqual(["browser", "writer"]);
  });

  it("500 від моделі → fallback, план валідний", async () => {
    const p = createPlanner({ apiKey: "k", baseUrl: `http://127.0.0.1:${port}/bad` });
    const plan = await p.plan({ prompt: "Відкрий https://example.com" });
    expect(plan.nodes.length).toBeGreaterThan(0);
  });
});

describe("end-to-end через API", () => {
  it("plan.created містить router і planner", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${port}`;
    const app = await buildApp();
    await app.ready();
    const created = await app.inject({ method: "POST", url: "/v1/runs", headers: { "x-tenant-id": "tnt_demo0001" },
      payload: { prompt: "Відкрий https://example.com і зроби висновок" } });
    const id = created.json().run.id;
    await app.engine.drain();
    const ev = (await app.inject({ method: "GET", url: `/v1/runs/${id}/events`, headers: { "x-tenant-id": "tnt_demo0001" } })).json();
    const planEv = ev.events.find((e: any) => e.type === "plan.created");
    expect(planEv.payload.planner).toBe("deepseek");
    expect(planEv.payload.router).toBe("deepseek");
    expect(planEv.payload.nodes).toBeGreaterThan(0);
    await app.close();
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_BASE_URL;
  });
});
