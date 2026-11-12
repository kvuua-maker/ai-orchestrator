import { z } from "zod";
import type { Db } from "../db/index.js";
import { defineTool } from "./sdk.js";
import { createEmbedder, type Embedder } from "../memory/embedder.js";
import { ingestText, searchMemory } from "../memory/store.js";

export function createMemoryTools(db: Db, embedder: Embedder = createEmbedder()) {
  const remember = defineTool({
    name: "memory.remember",
    version: "1.0.0",
    description: "Store text in tenant memory: chunked and embedded for later semantic search.",
    input: z.object({
      sourceType: z.enum(["document", "run", "note", "contact"]).default("note"),
      sourceId: z.string().min(1).max(200),
      text: z.string().min(1).max(200_000),
    }),
    output: z.object({ sourceId: z.string(), chunks: z.number(), stored: z.number(), tokens: z.number() }),
    risk: "write", effectClass: "idempotent", costClass: "cheap",
    scopes: ["memory:write"], agents: ["data", "writer", "ops", "synthesizer"],
    timeoutMs: 60_000,
    async execute(input, ctx) {
      const r = await db.tx(ctx.tenantId, (q) => ingestText(q, { ...input, tenantId: ctx.tenantId, embedder }));
      return { data: { sourceId: r.sourceId, chunks: r.chunks, stored: r.stored, tokens: r.tokens }, costMicros: 500 };
    },
  });

  const search = defineTool({
    name: "memory.search",
    version: "1.0.0",
    description: "Semantic + lexical search over tenant memory. Returns the most relevant chunks with scores.",
    input: z.object({
      query: z.string().min(1).max(2000),
      k: z.number().int().min(1).max(50).default(5),
      sourceType: z.enum(["document", "run", "note", "contact"]).optional(),
      threshold: z.number().min(0).max(1).optional(),
    }),
    output: z.object({
      hits: z.array(z.object({
        sourceId: z.string(), chunkIndex: z.number(), content: z.string(),
        score: z.number(), cosine: z.number(), lexical: z.number(),
      })),
      embedder: z.string(),
    }),
    risk: "read", effectClass: "pure", costClass: "cheap",
    scopes: ["memory:read"], agents: ["browser", "data", "writer", "verifier", "synthesizer", "ops"],
    timeoutMs: 30_000,
    async execute(input, ctx) {
      const [qv] = await embedder.embed([input.query]);
      const hits = await db.tx(ctx.tenantId, (q) => searchMemory(q, {
        embedding: Array.from(qv!), query: input.query, k: input.k, sourceType: input.sourceType, threshold: input.threshold,
      }));
      return { data: { hits, embedder: embedder.name }, costMicros: 300 };
    },
  });

  return [remember, search];
}
