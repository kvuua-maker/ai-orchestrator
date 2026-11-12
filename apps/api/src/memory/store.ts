import { createHash } from "node:crypto";
import type { QueryFn } from "../db/index.js";
import { newId } from "../ids.js";
import { chunkText } from "./chunk.js";
import type { Embedder } from "./embedder.js";

export interface IngestResult { sourceId: string; chunks: number; stored: number; tokens: number; embedder: string }

export async function ingestText(
  q: QueryFn,
  input: { tenantId: string; sourceType: string; sourceId: string; text: string; embedder: Embedder },
): Promise<IngestResult> {
  const chunks = chunkText(input.text);
  if (!chunks.length) return { sourceId: input.sourceId, chunks: 0, stored: 0, tokens: 0, embedder: input.embedder.name };

  const vectors = await input.embedder.embed(chunks.map((c) => c.content));
  if (vectors.length !== chunks.length) throw new Error("embedder returned wrong number of vectors");

  let stored = 0;
  for (const [i, c] of chunks.entries()) {
    const v = `{${Array.from(vectors[i]!).map((x) => (Number.isFinite(x) ? x.toFixed(6) : "0")).join(",")}}`;
    await q(
      `INSERT INTO memory_chunks (id, tenant_id, source_type, source_id, chunk_index, content, content_hash, embedding, tokens)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::real[],$9)
       ON CONFLICT (tenant_id, source_id, chunk_index)
       DO UPDATE SET content=$6, content_hash=$7, embedding=$8::real[], tokens=$9, created_at=now()`,
      [newId.run(), input.tenantId, input.sourceType, input.sourceId, c.index, c.content,
       createHash("sha256").update(c.content).digest("hex"), v, c.tokens],
    );
    stored++;
  }
  // прибираємо чанки, яких більше немає (текст скоротився)
  await q("DELETE FROM memory_chunks WHERE tenant_id=$1 AND source_id=$2 AND chunk_index >= $3",
    [input.tenantId, input.sourceId, chunks.length]);

  return { sourceId: input.sourceId, chunks: chunks.length, stored, tokens: chunks.reduce((s, c) => s + c.tokens, 0), embedder: input.embedder.name };
}

export interface MemoryHit {
  id: string; sourceType: string; sourceId: string; chunkIndex: number;
  content: string; score: number; cosine: number; lexical: number;
}

/** Гібридний пошук: семантика + триграми, у межах тенанта через RLS (§10.4). */
export async function searchMemory(
  q: QueryFn,
  input: { embedding: number[]; query: string; k?: number; threshold?: number; sourceType?: string; lexicalWeight?: number },
): Promise<MemoryHit[]> {
  const k = Math.min(Math.max(input.k ?? 5, 1), 50);
  const threshold = input.threshold ?? 0.2;
  const lw = input.lexicalWeight ?? 0.3;
  const vec = `{${input.embedding.map((x) => (Number.isFinite(x) ? x.toFixed(6) : "0")).join(",")}}`;

  const { rows } = await q<any>(
    `SELECT * FROM (
       SELECT id, source_type, source_id, chunk_index, content,
              cosine_similarity(embedding, $1::real[]) AS cos,
              similarity(content, $2) AS lex
       FROM memory_chunks
       WHERE ($4::text IS NULL OR source_type = $4)
     ) t
     WHERE (($3::float8 * cos) + ((1 - $3::float8) * lex)) >= $5
     ORDER BY (($3::float8 * cos) + ((1 - $3::float8) * lex)) DESC
     LIMIT $6`,
    [vec, input.query, 1 - lw, input.sourceType ?? null, threshold, k],
  );

  return rows.map((r: any) => ({
    id: r.id, sourceType: r.source_type, sourceId: r.source_id, chunkIndex: r.chunk_index,
    content: r.content, score: Number((0.7 * r.cos + 0.3 * r.lex).toFixed(4)),
    cosine: Number(Number(r.cos).toFixed(4)), lexical: Number(Number(r.lex).toFixed(4)),
  }));
}

export async function memoryStats(q: QueryFn) {
  const { rows } = await q<any>(
    `SELECT count(*)::int AS chunks, count(DISTINCT source_id)::int AS sources, coalesce(sum(tokens),0)::int AS tokens
     FROM memory_chunks`);
  return rows[0] ?? { chunks: 0, sources: 0, tokens: 0 };
}

export async function forgetSource(q: QueryFn, sourceId: string): Promise<number> {
  const { rows } = await q<any>("DELETE FROM memory_chunks WHERE source_id=$1 RETURNING id", [sourceId]);
  return rows.length;
}
