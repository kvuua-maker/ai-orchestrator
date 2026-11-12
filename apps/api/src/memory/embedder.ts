import { createHash } from "node:crypto";

export interface Embedder {
  readonly name: string;
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/**
 * Детермінований offline-ембеддер (feature hashing).
 * Не семантичний: ловить лексичну близькість. Використовується як fallback
 * і в тестах, де завантаження моделі недоречне (§10.2.3).
 */
export class HashingEmbedder implements Embedder {
  readonly name = "hashing-384";
  readonly dim: number;
  constructor(dim = 384) { this.dim = dim; }

  private vector(text: string): Float32Array {
    const v = new Float32Array(this.dim);
    const norm = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const words = norm.split(/\s+/).filter(Boolean);
    const grams: string[] = [...words];
    for (const w of words) for (let i = 0; i < Math.max(1, w.length - 2); i++) grams.push(w.slice(i, i + 3));
    for (const g of grams) {
      const h = createHash("sha1").update(g).digest();
      const idx = ((h[0]! << 16) | (h[1]! << 8) | h[2]!) % this.dim;
      const sign = h[3]! % 2 === 0 ? 1 : -1;
      v[idx] = (v[idx] ?? 0) + sign;
    }
    let n = 0; for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i] = v[i]! / n;
    return v;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.vector(t));
  }
}

/** Реальні семантичні ембеддинги локально через ONNX (fastembed). */
export class FastEmbedEmbedder implements Embedder {
  readonly name: string;
  readonly dim = 384;
  private modelPromise: Promise<any> | null = null;
  constructor(private readonly model = process.env.EMBEDDING_MODEL ?? "fast-bge-small-en-v1.5") {
    this.name = `fastembed:${model}`;
  }

  private async model_() {
    if (!this.modelPromise) {
      this.modelPromise = (async () => {
        const { FlagEmbedding } = await import("fastembed");
        return FlagEmbedding.init({ model: this.model as any });
      })();
    }
    return this.modelPromise;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const m = await this.model_();
    const out: Float32Array[] = [];
    for await (const batch of m.embed(texts)) out.push(...batch.map((b: number[]) => Float32Array.from(b)));
    return out;
  }
}

export function createEmbedder(): Embedder {
  const kind = process.env.EMBEDDER ?? "hashing";
  return kind === "fastembed" ? new FastEmbedEmbedder() : new HashingEmbedder();
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { s += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na && nb ? s / Math.sqrt(na * nb) : 0;
}
