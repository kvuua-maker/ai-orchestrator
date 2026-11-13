import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { buildApp } from "../src/app.js";

const H = { "x-tenant-id": "tnt_demo0001" };
let srv: Server, port = 0;
let planJson: any = {};
let streamText = "";
let lastSystem = "";
let lastUser = "";
let calls = 0;

beforeAll(async () => {
  srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls++;
      const parsed = body ? JSON.parse(body) : {};
      lastSystem = parsed?.messages?.[0]?.content ?? "";
      lastUser = parsed?.messages?.[1]?.content ?? "";
      if (parsed.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const piece of streamText.match(/.{1,12}/gs) ?? []) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(planJson) } }] }));
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

const newConv = async (app: any) =>
  (await app.inject({ method: "POST", url: "/v1/conversations", headers: H, payload: {} })).json().conversation;

describe("Діалог (стрімінг)", () => {
  it("питання → класифікація answer + потоковий текст", async () => {
    planJson = { intent: "answer" };
    streamText = "Я вмію **багато**: перевіряти сайти, читати чеки.";
    const app = await buildApp(); await app.ready();
    const conv = await newConv(app);
    const r = await app.inject({ method: "POST", url: `/v1/conversations/${conv.id}/messages`, headers: H, payload: { text: "Що ти вмієш?" } });
    const b = r.json();
    expect(r.statusCode).toBe(200);
    expect(b.intent).toBe("answer");
    expect(b.runId).toBeNull();
    expect(b.content).toContain("багато");
    expect(b.messageId).toMatch(/^msg_/);
    await app.close();
  });

  it("нечіткий запит → одразу act з припущенням, без допиту", async () => {
    planJson = { intent: "clarify" };   // модель намагається уточнити — ми це забороняємо
    streamText = "Беру базовий iPhone 15 і порівнюю ціни. Починаю.";
    const app = await buildApp(); await app.ready();
    const conv = await newConv(app);
    const b = (await app.inject({ method: "POST", url: `/v1/conversations/${conv.id}/messages`, headers: H, payload: { text: "перевір ціни" } })).json();
    // нова архітектура: модель сама вирішує; окремого run для чату більше немає
    expect(b.intent).toBe("answer");
    expect(b.content.length).toBeGreaterThan(10);
    expect(b.runId ?? null).toBeNull();
    expect(b.options ?? []).toHaveLength(0);
    await app.close();
  }, 30_000);

  it("задача → план + run + фінальний підсумок у розмові", async () => {
    planJson = { intent: "act", plan: ["відкрити сайт", "витягти текст"] };
    streamText = "Я зрозумів. Відкрию сайт і підсумую. Починаю.";
    const app = await buildApp(); await app.ready();
    const conv = await newConv(app);
    const b = (await app.inject({ method: "POST", url: `/v1/conversations/${conv.id}/messages`, headers: H, payload: { text: "Перевір https://example.com" } })).json();
    expect(b.intent).toBe("answer");
    expect(String(b.content).length).toBeGreaterThan(10);
    expect(b.runId ?? null).toBeNull();
    await app.engine.drain();
    const msgs = (await app.inject({ method: "GET", url: `/v1/conversations/${conv.id}`, headers: H })).json().messages;
    expect(msgs.length).toBeGreaterThanOrEqual(2);   // нова архітектура: без окремого повідомлення-плану
    expect(msgs.some((m: any) => m.role === "assistant" && String(m.content).length > 5)).toBe(true);
    await app.close();
  }, 60_000);

  it("історія і персона передаються в модель", async () => {
    planJson = { intent: "answer" };
    streamText = "Так, пам'ятаю.";
    const app = await buildApp(); await app.ready();
    const conv = await newConv(app);
    await app.inject({ method: "POST", url: `/v1/conversations/${conv.id}/messages`, headers: H, payload: { text: "Мене звати Олег" } });
    await app.inject({ method: "POST", url: `/v1/conversations/${conv.id}/messages`, headers: H, payload: { text: "Як мене звати?" } });
    expect(lastSystem).toContain("AI Orchestrator");
    expect(lastUser).toContain("Мене звати Олег");
    await app.close();
  });

  it("список розмов і 404", async () => {
    const app = await buildApp(); await app.ready();
    await newConv(app);
    const list = (await app.inject({ method: "GET", url: "/v1/conversations", headers: H })).json();
    expect(list.items.length).toBeGreaterThan(0);
    const miss = await app.inject({ method: "GET", url: "/v1/conversations/cnv_nope", headers: H });
    expect(miss.statusCode).toBe(404);
    await app.close();
  });
});
