import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { buildApp } from "../src/app.js";

const H = { "x-tenant-id": "tnt_demo0001" };
let srv: Server, port = 0;
let lastUser = "";
let lastSystem = "";

beforeAll(async () => {
  srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const p = body ? JSON.parse(body) : {};
      lastUser = p?.messages?.[1]?.content ?? "";
      lastSystem = p?.messages?.[0]?.content ?? "";
      if (p.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
        res.write("data: [DONE]\n\n"); res.end(); return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ intent: "answer" }) } }] }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  port = (srv.address() as any).port;
  process.env.DEEPSEEK_API_KEY = "t"; process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => srv.close(() => r()));
  delete process.env.DEEPSEEK_API_KEY; delete process.env.DEEPSEEK_BASE_URL;
});

describe("Факти в промпті", () => {
  it("збережений факт потрапляє в контекст наступного ходу", async () => {
    const app = await buildApp(); await app.ready();
    await app.db.tx("tnt_demo0001", (q) => q("DELETE FROM memory_chunks"));
    await app.inject({ method: "POST", url: "/v1/memory/ingest", headers: H,
      payload: { sourceType: "note", sourceId: "f1", text: "Головний постачальник клієнта — Сільпо" } });
    const conv = (await app.inject({ method: "POST", url: "/v1/conversations", headers: H, payload: {} })).json().conversation;
    await app.inject({ method: "POST", url: `/v1/conversations/${conv.id}/messages`, headers: H,
      payload: { text: "Хто мій головний постачальник?" } });
    expect(lastSystem).toContain("Сільпо");        // факти у системному промпті
    expect(lastSystem).toContain("Факти про клієнта");
    await app.close();
  }, 60_000);
});
