import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/app.js";

let app: Awaited<ReturnType<typeof buildApp>>;
const H = { "x-tenant-id": "tnt_demo0001" };
const B = { "x-tenant-id": "tnt_other001" };

beforeAll(async () => {
  app = await buildApp(); await app.ready();
  await app.db.tx("tnt_demo0001", (q) => q("DELETE FROM memory_chunks"));
});
afterAll(async () => { await app.close(); });

describe("memory API", () => {
  it("ingest → пошук знаходить потрібне", async () => {
    const ing = await app.inject({ method: "POST", url: "/v1/memory/ingest", headers: H, payload: {
      sourceType: "document", sourceId: "api-doc-1",
      text: "ТОВ Сільпо, чек 03.11.2026. Молоко 2 x 42.50, хліб 1 x 28.00. Всього 113.00 гривень.",
    } });
    expect(ing.statusCode).toBe(201);
    expect(ing.json().chunks).toBe(1);

    const s = await app.inject({ method: "POST", url: "/v1/memory/search", headers: H, payload: { query: "молоко", threshold: 0 } });
    expect(s.statusCode).toBe(200);
    expect(s.json().hits[0].sourceId).toBe("api-doc-1");
    expect(s.json().embedder).toBeTruthy();
  });

  it("чужий тенант нічого не знаходить", async () => {
    const s = await app.inject({ method: "POST", url: "/v1/memory/search", headers: B, payload: { query: "молоко", threshold: 0 } });
    expect(s.json().hits).toHaveLength(0);
  });

  it("stats показує кількість чанків", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/memory/stats", headers: H });
    expect(r.json().chunks).toBeGreaterThan(0);
  });

  it("порожній запит → 422", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/memory/search", headers: H, payload: { query: "" } });
    expect(r.statusCode).toBe(422);
  });
});

describe("кеш документів", () => {
  it("другий виклик віддає x-cache: hit і той самий результат", async () => {
    const content = "ТОВ Тест\nЄДРПОУ 40720196\n03.11.2026\nВсього 113.00\nПДВ 18.83";
    const pre = await app.inject({ method: "POST", url: "/v1/uploads/presign", headers: H, payload: { filename: "c.txt", mime: "text/plain", sizeBytes: content.length } });
    const { uploadId } = pre.json();
    await app.inject({ method: "PUT", url: `/v1/uploads/${uploadId}/parts/1`, headers: { ...H, "content-type": "application/octet-stream" }, payload: Buffer.from(content) });
    const up = (await app.inject({ method: "POST", url: `/v1/uploads/${uploadId}/complete`, headers: H, payload: {} })).json();

    const first = await app.inject({ method: "POST", url: "/v1/documents/process", headers: H, payload: { key: up.artifact.key } });
    const second = await app.inject({ method: "POST", url: "/v1/documents/process", headers: H, payload: { key: up.artifact.key } });
    expect(second.headers["x-cache"]).toBe("hit");
    expect(second.json()).toEqual(first.json());
  });

  it("cache stats рахує влучання", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/cache/stats", headers: H });
    expect(r.json().hits).toBeGreaterThanOrEqual(1);
  });

  it("cache не протікає між тенантами", async () => {
    const s = await app.inject({ method: "GET", url: "/v1/cache/stats", headers: B });
    expect(s.json().hits).toBe(0);
  });
});

describe("memory tools у каталозі", () => {
  it("memory.search і memory.remember зареєстровані", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/tools", headers: H });
    const names = r.json().items.map((i: any) => i.name);
    expect(names).toContain("memory.search");
    expect(names).toContain("memory.remember");
  });
});
