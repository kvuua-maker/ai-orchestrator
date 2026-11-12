import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/app.js";

let app: Awaited<ReturnType<typeof buildApp>>;
const H = { "x-tenant-id": "tnt_demo0001" };

const RECEIPT = `ТОВ "СІЛЬПО-ФУД"
ЄДРПОУ 40720196
Каса 3  03.11.2026 14:22
Молоко 2 x 42.50
Хліб 1 x 28.00
Всього 113.00
ПДВ 18.83`;

beforeAll(async () => { app = await buildApp(); await app.ready(); });
afterAll(async () => { await app.close(); });

async function upload(content: string | Buffer, name: string, mime = "text/plain") {
  const pre = await app.inject({ method: "POST", url: "/v1/uploads/presign", headers: H, payload: { filename: name, mime, sizeBytes: content.length } });
  const { uploadId } = pre.json();
  await app.inject({ method: "PUT", url: `/v1/uploads/${uploadId}/parts/1`, headers: { ...H, "content-type": "application/octet-stream" }, payload: Buffer.from(content as any) });
  const done = await app.inject({ method: "POST", url: `/v1/uploads/${uploadId}/complete`, headers: H, payload: {} });
  return done.json();
}

describe("documents pipeline API", () => {
  it("upload → process → promoted з полями", async () => {
    const up = await upload(RECEIPT, "receipt.txt");
    const r = await app.inject({ method: "POST", url: "/v1/documents/process", headers: H, payload: { key: up.artifact.key } });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.status).toBe("promoted");
    expect(b.parsed.total).toBe(113);
    expect(b.parsed.edrpou).toBe("40720196");
    expect(b.engine).toBe("text-layer");
  });

  it("невідомий ключ → 404", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/documents/process", headers: H, payload: { key: "a".repeat(64) } });
    expect(r.statusCode).toBe(404);
  });

  it("чужий тенант не обробляє артефакт", async () => {
    const up = await upload("x", "x.txt");
    const r = await app.inject({ method: "POST", url: "/v1/documents/process", headers: { "x-tenant-id": "tnt_other001" }, payload: { key: up.artifact.key } });
    expect(r.statusCode).toBe(404);
  });

  it("export xlsx → артефакт + робоче посилання", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/documents/export", headers: H, payload: {
      format: "xlsx", title: "Звіт", columns: ["Дата", "Сума"], rows: [{ Дата: "2026-11-03", Сума: 113 }],
    } });
    expect(r.statusCode).toBe(201);
    const b = r.json();
    expect(b.name).toMatch(/\.xlsx$/);
    const dl = await app.inject({ method: "GET", url: b.url, headers: H });
    expect(dl.statusCode).toBe(200);
    expect(Buffer.from(dl.rawPayload).slice(0, 2).toString()).toBe("PK");
  });

  it("export pdf → %PDF", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/documents/export", headers: H, payload: {
      format: "pdf", title: "Report", columns: ["A"], rows: [{ A: "1" }],
    } });
    expect(Buffer.from(r.json().url ? (await app.inject({ method: "GET", url: r.json().url, headers: H })).rawPayload : []).slice(0, 4).toString()).toBe("%PDF");
  });

  it("folders: план переміщень", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/documents/folders", headers: H, payload: {
      docs: [
        { key: "k1", name: "a.pdf", date: "2026-11-03", merchant: "Сільпо", total: 113, sha256: "a".repeat(64) },
        { key: "k2", name: "b.pdf", date: "2026-11-04", merchant: "АТБ", total: 87.5, sha256: "b".repeat(64) },
      ],
    } });
    const b = r.json();
    expect(b.moves.length).toBe(2);
    expect(b.moves[0].to).toContain("2026/11");
  });
});
