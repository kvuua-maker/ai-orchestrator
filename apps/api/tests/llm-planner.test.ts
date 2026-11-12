import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { buildApp } from "../src/app.js";
import { createPlanner } from "../src/engine/llm-planner.js";

/** Мок DeepSeek: доводить, що реальний HTTP-шлях планувальника працює. */
let srv: Server, port = 0;
beforeAll(async () => {
  srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const ok = req.url?.includes("/chat/completions");
      res.writeHead(ok ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        nodes: [
          { agent: "browser", goal: "Відкрити сторінку", tools: ["http.fetch"], estCostUsd: 0.001 },
          { agent: "writer", goal: "Написати висновок", tools: [], estCostUsd: 0.002 },
        ],
      }) } }] }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  port = (srv.address() as any).port;
});
afterAll(async () => { await new Promise<void>((r) => srv.close(() => r())); });

describe("DeepSeek planner", () => {
  it("без ключа — детермінований stub", async () => {
    const p = createPlanner({ apiKey: "" });
    expect(p.name).toBe("stub");
    const plan = await p.plan({ prompt: "зроби щось", budget: {} });
    expect(plan.nodes.length).toBeGreaterThan(0);
  });

  it("з ключем — ходить у /chat/completions і повертає план моделі", async () => {
    const p = createPlanner({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${port}` });
    expect(p.name).toBe("deepseek");
    const plan = await p.plan({ prompt: "Відкрий сайт і зроби висновок", budget: {} });
    expect(plan.nodes.map((n) => n.agent)).toEqual(["browser", "writer"]);
    expect(plan.nodes[0]!.tools).toContain("http.fetch");
  });

  it("при 500 від моделі — fallback, run не падає", async () => {
    const p = createPlanner({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${port}/bad` });
    const plan = await p.plan({ prompt: "Відкрий https://example.com", budget: {} });
    expect(plan.nodes.length).toBeGreaterThan(0); // stub-план
  });

  it("end-to-end: подія plan.created містить planner=deepseek", async () => {
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
    await app.close();
    delete process.env.DEEPSEEK_API_KEY;
  });
});
