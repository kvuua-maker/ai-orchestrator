import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { buildApp } from "../src/app.js";

const H = { "x-tenant-id": "tnt_demo0001" };
let srv: Server, port = 0;
let replyJson: any = {};
let lastSystem = "";
let lastUser = "";

beforeAll(async () => {
  srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      lastSystem = parsed?.messages?.[0]?.content ?? "";
      lastUser = parsed?.messages?.[1]?.content ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(replyJson) } }] }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  port = (srv.address() as any).port;
  process.env.DEEPSEEK_API_KEY = "test";
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => srv.close(() => r()));
  delete process.env.DEEPSEEK_API_KEY; delete process.env.DEEPSEEK_BASE_URL;
});

describe("Діалог", () => {
  it("питання → текстовa відповідь без запуску задачі", async () => {
    replyJson = { intent: "answer", reply: "Я вмію **багато**: перевіряти сайти, читати чеки." };
    const app = await buildApp(); await app.ready();
    const conv = (await app.inject({ method: "POST", url: "/v1/conversations", headers: H, payload: {} })).json().conversation;
    const r = await app.inject({ method: "POST", url: `/v1/conversations/${conv.id}/messages`, headers: H, payload: { text: "Що ти вмієш?" } });
    const b = r.json();
    expect(r.statusCode).toBe(200);
    expect(b.intent).toBe("answer");
    expect(b.runId).toBeNull();
    expect(b.assistantMessage.content).toContain("Я вмію");
    expect(b.assistantMessage.content).toContain("**багато**");
    await app.close();
  });

  it("нечіткий запит → clarify з варіантами", async () => {
    replyJson = { intent: "clarify", reply: "Уточніть, будь ласка: який сайт?", options: ["Сайт постачальника", "Свій кабінет"] };
    const app = await buildApp(); await app.ready();
    const conv = (await app.inject({ method: "POST", url: "/v1/conversations", headers: H, payload: {} })).json().conversation;
    const r = (await app.inject({ method: "POST", url: `/v1/conversations/${conv.id}/messages`, headers: H, payload: { text: "перевір ціни" } })).json();
    expect(r.intent).toBe("clarify");
    expect(r.assistantMessage.meta.options).toHaveLength(2);
    await app.close();
  });

  it("задача → план у повідомленні + створений run", async () => {
    replyJson = { intent: "act", reply: "Я зрозумів. План: перевірити сайт. Починаю.", plan: ["відкрити сайт", "витягти текст"] };
    const app = await buildApp(); await app.ready();
    const conv = (await app.inject({ method: "POST", url: "/v1/conversations", headers: H, payload: {} })).json().conversation;
    const r = (await app.inject({ method: "POST", url: `/v1/conversations/${conv.id}/messages`, headers: H, payload: { text: "Перевір https://example.com" } })).json();
    expect(r.intent).toBe("act");
    expect(r.runId).toMatch(/^run_/);
    expect(r.assistantMessage.meta.plan).toHaveLength(2);
    await app.engine.drain();
    const msgs = (await app.inject({ method: "GET", url: `/v1/conversations/${conv.id}`, headers: H })).json().messages;
    expect(msgs.length).toBeGreaterThanOrEqual(3);           // user + план + підсумок
    expect(msgs.some((m: any) => m.meta?.intent === "result")).toBe(true);
    await app.close();
  }, 60_000);

  it("історія передається в LLM (пам'ять контексту)", async () => {
    replyJson = { intent: "answer", reply: "Так, пам'ятаю." };
    const app = await buildApp(); await app.ready();
    const conv = (await app.inject({ method: "POST", url: "/v1/conversations", headers: H, payload: {} })).json().conversation;
    await app.inject({ method: "POST", url: `/v1/conversations/${conv.id}/messages`, headers: H, payload: { text: "Мене звати Олег" } });
    await app.inject({ method: "POST", url: `/v1/conversations/${conv.id}/messages`, headers: H, payload: { text: "Як мене звати?" } });
    expect(lastSystem).toContain("AI Orchestrator");       // персона передана
    expect(lastUser).toContain("Мене звати Олег");        // історія передана
    const msgs = (await app.inject({ method: "GET", url: `/v1/conversations/${conv.id}`, headers: H })).json().messages;
    expect(msgs.filter((m: any) => m.role === "user").length).toBe(2);
    await app.close();
  });

  it("список розмов і 404 на невідому", async () => {
    const app = await buildApp(); await app.ready();
    await app.inject({ method: "POST", url: "/v1/conversations", headers: H, payload: {} });
    const list = (await app.inject({ method: "GET", url: "/v1/conversations", headers: H })).json();
    expect(list.items.length).toBeGreaterThan(0);
    const miss = await app.inject({ method: "GET", url: "/v1/conversations/cnv_nope", headers: H });
    expect(miss.statusCode).toBe(404);
    await app.close();
  });
});
