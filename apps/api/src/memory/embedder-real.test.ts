import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FastEmbedEmbedder, cosine } from "./embedder.js";
import { createDb, seed, type Db } from "../db/index.js";
import { ingestText, searchMemory } from "./store.js";

const REAL = process.env.EMBEDDER_REAL === "1";

describe.skipIf(!REAL)("FastEmbed (реальна семантика)", () => {
  let db: Db;
  const tenant = "tnt_demo0001";
  const embedder = new FastEmbedEmbedder();

  beforeAll(async () => {
    db = await createDb(); await seed(db);
    await db.tx(tenant, (q) => q("DELETE FROM memory_chunks"));
  });
  afterAll(async () => { await db.close(); });

  it("розрізняє семантичну близькість без спільних слів", async () => {
    const [a, b, c] = await embedder.embed([
      "automobile purchase receipt",
      "car bought at the dealership",
      "recipe for chocolate cake",
    ]);
    expect(cosine(a!, b!)).toBeGreaterThan(cosine(a!, c!));
  }, 120_000);

  it("пошук знаходить документ за перефразованим запитом", async () => {
    await db.tx(tenant, (q) => ingestText(q, { tenantId: tenant, sourceType: "document", sourceId: "sem-1",
      text: "Fiscal receipt from Silpo supermarket: milk and bread, total 113 hryvnia, paid by card.", embedder }));
    await db.tx(tenant, (q) => ingestText(q, { tenantId: tenant, sourceType: "document", sourceId: "sem-2",
      text: "Weather forecast for tomorrow: rain and strong wind.", embedder }));

    const [qv] = await embedder.embed(["how much did the groceries cost"]);
    const hits = await db.tx(tenant, (q) => searchMemory(q, { embedding: Array.from(qv!), query: "groceries cost", k: 2, threshold: 0 }));
    expect(hits[0]!.sourceId).toBe("sem-1");
  }, 120_000);
});
