export interface Chunk { index: number; content: string; tokens: number }

const approxTokens = (s: string) => Math.ceil(s.length / 4);

/**
 * Розбиття на чанки з перекриттям, по межах речень (§10.2.2).
 * Детерміноване: той самий текст → ті самі чанки.
 */
export function chunkText(text: string, opts: { size?: number; overlap?: number } = {}): Chunk[] {
  const size = opts.size ?? 900;
  const overlap = opts.overlap ?? 120;
  const clean = text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
  if (!clean) return [];
  if (clean.length <= size) return [{ index: 0, content: clean, tokens: approxTokens(clean) }];

  const sentences = clean.match(/[^.!?\n]+[.!?]?\s*/g) ?? [clean];
  const chunks: Chunk[] = [];
  let buf = "";
  for (const s of sentences) {
    if (buf.length + s.length > size && buf.length > 0) {
      chunks.push({ index: chunks.length, content: buf.trim(), tokens: approxTokens(buf) });
      const tail = buf.slice(Math.max(0, buf.length - overlap));
      buf = tail + s;
    } else {
      buf += s;
    }
  }
  if (buf.trim()) chunks.push({ index: chunks.length, content: buf.trim(), tokens: approxTokens(buf) });
  return chunks;
}
