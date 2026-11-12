import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkText } from "./chunk.js";
import { HashingEmbedder, cosine } from "./embedder.js";
import { ingestText, searchMemory, memoryStats, forgetSource } from "./store.js";
import { cacheKey, cacheGet, cacheSet, cacheStats, cachePurgeExpired } from "./cache.js";
import { createDb, seed, type Db } from "../db/index.js";

describe("chunker", () => {
  it("короткий текст — один чанк", () => {
    expect(chunkText("привіт світ")).toHaveLength(1);
  });
  it("довгий текст ріжеться на кілька чанків із перекриттям", () => {
    const text = Array.from({ length: 40 }, (_, i) => `Речення номер ${i} про документи та чеки.`).join(" ");
    const chunks = chunkText(text, { size: 300, overlap: 60 });
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c) => c.content.length <= 340)).toBe(true);
  });
  it("детермінований", () => {
    const t = "А. Б. В. Г.";
    expect(chunkText(t)).toEqual(chunkText(t));
  });
  it("порожній → нічого", () => {
    expect(chunkText("   ")).toEqual([]);
  });
});

describe("HashingEmbedder", () => {
  it("схожі тексти ближчі за неспоріднені", async () => {
    const e = new HashingEmbedder();
    const [a, b, c] = await e.embed([
      "чек на суму 113 гривень молоко хліб",
      "чек на суму 250 гривень молоко",
      "погода завтра дощ вітер",
    ]);
    expect(cosine(a!, b!)).toBeGreaterThan(cosine(a!, c!));
  });
  it("детермінований і нормований", async () => {
    const e = new HashingEmbedder();
    const [v1] = await e.embed(["тест"]);
    const [v2] = await e.embed(["тест"]);
    expect(Array.from(v1!)).toEqual(Array.from(v2!));
    expect(Math.abs(cosine(v1!, v1!) - 1)).toBeLessThan(1e-6);
  });
});

describe("memory store (Postgres)", () => {
  let db: Db;
  const tenant = "tnt_demo0001";
  const embedder = new HashingEmbedder();

  beforeAll(async () => {
    db = await createDb(); await seed(db);
    await db.tx(tenant, (q) => q("DELETE FROM memory_chunks"));   // детермінований старт
  });
  afterAll(async () => { await db.close(); });

  it("ingest → пошук повертає релевантний чанк першим", async () => {
    await db.tx(tenant, (q) => ingestText(q, { tenantId: tenant, sourceType: "document", sourceId: "doc-1",
      text: "ТОВ Сільпо. Чек від 03.11.2026. Молоко 2 x 42.50. Хліб 1 x 28.00. Всього 113.00 гривень.", embedder }));
    await db.tx(tenant, (q) => ingestText(q, { tenantId: tenant, sourceType: "document", sourceId: "doc-2",
      text: "Погода на завтра: дощ, вітер 12 м/с, температура +8.", embedder }));

    const [qv] = await embedder.embed(["скільки коштувало молоко в чеку"]);
    const hits = await db.tx(tenant, (q) => searchMemory(q, { embedding: Array.from(qv!), query: "молоко чек", k: 3, threshold: 0 }));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.sourceId).toBe("doc-1");
    expect(hits[0]!.score).toBeGreaterThan(0);
  });

  it("тенант не бачить чужі чанки (RLS)", async () => {
    const [qv] = await embedder.embed(["чек молоко"]);
    const hits = await db.tx("tnt_other001", (q) => searchMemory(q, { embedding: Array.from(qv!), query: "молоко чех", threshold: 0, k: 10 }));
    expect(hits.every((h) => h.sourceId.startsWith("doc-"))).toBe(true);
    expect(hits.length).toBe(0);
  });

  it("повторний ingest оновлює, а не дублює", async () => {
    const before = await db.tx(tenant, (q) => memoryStats(q));
    await db.tx(tenant, (q) => ingestText(q, { tenantId: tenant, sourceType: "document", sourceId: "doc-1",
      text: "Оновлений текст чека: молоко 2 x 50.00, всього 100.00", embedder }));
    const after = await db.tx(tenant, (q) => memoryStats(q));
    expect(after.chunks).toBe(before.chunks);
  });

  it("коротший текст прибирає зайві чанки", async () => {
    const long = Array.from({ length: 120 }, (_, i) => `Речення ${i} про документи та чеки.`).join(" ");
    await db.tx(tenant, (q) => ingestText(q, { tenantId: tenant, sourceType: "document", sourceId: "doc-short", text: long, embedder }));
    const many = await db.tx(tenant, (q) => q<any>("SELECT count(*)::int AS n FROM memory_chunks WHERE source_id='doc-short'"));
    await db.tx(tenant, (q) => ingestText(q, { tenantId: tenant, sourceType: "document", sourceId: "doc-short", text: "коротко", embedder }));
    const few = await db.tx(tenant, (q) => q<any>("SELECT count(*)::int AS n FROM memory_chunks WHERE source_id='doc-short'"));
    expect(many.rows[0].n).toBeGreaterThan(1);
    expect(few.rows[0].n).toBe(1);
  });

  it("forget видаляє джерело", async () => {
    const removed = await db.tx(tenant, (q) => forgetSource(q, "doc-short"));
    expect(removed).toBeGreaterThan(0);
  });

  it("sourceType фільтрує", async () => {
    await db.tx(tenant, (q) => ingestText(q, { tenantId: tenant, sourceType: "note", sourceId: "note-1", text: "нотатка про молоко", embedder }));
    const [qv] = await embedder.embed(["молоко"]);
    const hits = await db.tx(tenant, (q) => searchMemory(q, { embedding: Array.from(qv!), query: "молоко", sourceType: "note", threshold: 0 }));
    expect(hits.every((h) => h.sourceType === "note")).toBe(true);
  });
});

describe("response cache", () => {
  let db: Db;
  beforeAll(async () => { db = await createDb(); await seed(db); });
  afterAll(async () => { await db.close(); });

  it("ключ залежить від тенанта і вмісту", () => {
    const a = cacheKey({ tenantId: "t1", kind: "plan", payload: { prompt: "x" } });
    const b = cacheKey({ tenantId: "t2", kind: "plan", payload: { prompt: "x" } });
    const c = cacheKey({ tenantId: "t1", kind: "plan", payload: { prompt: "y" } });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it("set → get → hits збільшується", async () => {
    const key = cacheKey({ tenantId: "tnt_demo0001", kind: "test", payload: { q: "погода" } });
    await db.tx("tnt_demo0001", (q) => cacheSet(q, { key, tenantId: "tnt_demo0001", kind: "test", payload: { answer: 42 }, ttlSeconds: 60 }));
    const hit = await db.tx("tnt_demo0001", (q) => cacheGet<{ answer: number }>(q, key));
    expect(hit?.answer).toBe(42);
    const stats = await db.tx("tnt_demo0001", (q) => cacheStats(q));
    expect(stats.hits).toBeGreaterThanOrEqual(1);
  });

  it("прострочений запис не повертається і прибирається", async () => {
    const key = cacheKey({ tenantId: "tnt_demo0001", kind: "test", payload: { q: "old" } });
    await db.tx("tnt_demo0001", (q) => q(`INSERT INTO response_cache (key,tenant_id,kind,payload,expires_at)
      VALUES ($1,'tnt_demo0001','test','{"a":1}'::jsonb, now() - interval '1 hour')`, [key]));
    expect(await db.tx("tnt_demo0001", (q) => cacheGet(q, key))).toBeNull();
    const purged = await db.tx("tnt_demo0001", (q) => cachePurgeExpired(q));
    expect(purged).toBeGreaterThanOrEqual(1);
  });

  it("RLS: чужий тенант не бачить кеш", async () => {
    const key = cacheKey({ tenantId: "tnt_demo0001", kind: "test", payload: { q: "secret" } });
    await db.tx("tnt_demo0001", (q) => cacheSet(q, { key, tenantId: "tnt_demo0001", kind: "test", payload: { a: 1 } }));
    expect(await db.tx("tnt_other001", (q) => cacheGet(q, key))).toBeNull();
  });
});
