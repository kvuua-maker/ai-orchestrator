import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/app.js";

let app: Awaited<ReturnType<typeof buildApp>>;
const H = { "x-tenant-id": "tnt_demo0001" };
beforeAll(async () => { app = await buildApp(); await app.ready(); });
afterAll(async () => { await app.close(); });

describe("tool catalog API", () => {
  it("GET /v1/tools повертає каталог", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/tools", headers: H });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.total).toBeGreaterThanOrEqual(5);
    expect(b.items.map((i: any) => i.name)).toContain("documents.export");
  });

  it("фільтр за агентом", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/tools?agent=browser", headers: H });
    expect(r.json().items.every((i: any) => i.allowedAgents.length === 0 || i.allowedAgents.includes("browser"))).toBe(true);
  });

  it("пошук за текстом", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/tools?q=receipt", headers: H });
    expect(r.json().items[0].name).toBe("documents.parseReceipt");
  });

  it("GET /v1/tools/:name віддає версії та схему", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/tools/documents.export", headers: H });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.versions).toEqual(["1.0.0"]);
    expect(b.definition.inputSchema.properties.format.enum).toEqual(["xlsx", "docx", "pdf"]);
  });

  it("невідомий інструмент → 404", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/tools/nope.nope", headers: H });
    expect(r.statusCode).toBe(404);
  });

  it("simulate: валідація входу", async () => {
    const bad = await app.inject({ method: "POST", url: "/v1/tools/documents.export/simulate", headers: H, payload: { args: { format: "exe" } } });
    expect(bad.json().ok).toBe(false);
    expect(bad.json().error.code).toBe("VALIDATION");
  });

  it("simulate: HTTP-інструмент показує рішення egress", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/tools/http.fetch/simulate", headers: H,
      payload: { args: { url: "https://example.com" }, agent: "browser" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.wouldAllow).toBe(true);
  });

  it("simulate: приватна адреса не проходить", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/tools/http.fetch/simulate", headers: H,
      payload: { args: { url: "https://127.0.0.1/x" }, agent: "browser" } });
    expect(r.json().data.wouldAllow).toBe(false);
    expect(r.json().data.reason).toBe("private_ip");
  });

  it("simulate: агент без прав → 403", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/tools/documents.export/simulate", headers: H,
      payload: { args: { format: "pdf", title: "x", columns: ["a"], rows: [] }, agent: "browser" } });
    expect(r.statusCode).toBe(403);
  });
});

describe("documents tools через реєстр", () => {
  it("documents.process обробляє завантажений артефакт", async () => {
    const content = `ТОВ "Тест"\nЄДРПОУ 40720196\n03.11.2026\nМолоко 2 x 42.50\nХліб 1 x 28.00\nВсього 113.00\nПДВ 18.83`;
    const pre = await app.inject({ method: "POST", url: "/v1/uploads/presign", headers: H, payload: { filename: "r.txt", mime: "text/plain", sizeBytes: content.length } });
    const { uploadId } = pre.json();
    await app.inject({ method: "PUT", url: `/v1/uploads/${uploadId}/parts/1`, headers: { ...H, "content-type": "application/octet-stream" }, payload: Buffer.from(content) });
    const up = (await app.inject({ method: "POST", url: `/v1/uploads/${uploadId}/complete`, headers: H, payload: {} })).json();

    const r = await app.inject({ method: "POST", url: "/v1/documents/process", headers: H, payload: { key: up.artifact.key } });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe("promoted");
  });
});
