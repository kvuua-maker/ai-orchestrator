import type { QueryFn } from "../db/index.js";
import type { LlmClient } from "../engine/llm.js";
import { searchMemory } from "../memory/store.js";
import type { Embedder } from "../memory/embedder.js";

export interface Suggestion { text: string; label: string }

/**
 * Проактивність: на старті розмови пропонуємо дії на основі пам'яті й минулих запусків.
 * Не вигадуємо — лише те, що справді робили або пам'ятаємо.
 */
export async function buildSuggestions(
  q: QueryFn,
  llm: LlmClient,
  embedder: Embedder | null,
  tenantId: string,
): Promise<{ suggestions: Suggestion[]; basis: string[] }> {
  const { rows: runs } = await q<any>(
    `SELECT prompt, status, created_at FROM runs WHERE status='done'
     ORDER BY created_at DESC LIMIT 5`);
  let facts: string[] = [];
  if (embedder) {
    try {
      const [qv] = await embedder.embed(["постачальники, документи, звіти"]);
      const found = await searchMemory(q, { embedding: Array.from(qv!), query: "постачальник документи звіт", k: 4, threshold: 0.2 });
      facts = found.map((f) => f.content).slice(0, 4);
    } catch { facts = []; }
  }

  const basis = [...runs.map((r: any) => `робив: ${String(r.prompt).slice(0, 80)}`), ...facts.map((f) => `знаю: ${f.slice(0, 80)}`)];
  if (!basis.length) return { suggestions: [], basis: [] };

  const out = await llm.json<{ suggestions?: Array<{ label?: string; text?: string }> }>({
    system: `Ти — AI-Orchestrator. На основі того, що вже робив клієнт, запропонуй 3 КОНКРЕТНІ наступні дії.
Поверни ЛИШЕ JSON: {"suggestions":[{"label":"коротко 2-4 слова","text":"повний запит для виконання"}]}
Не пропонуй те, чого не вмієш (платежі, КЕП, CAPTCHA). Українською.`,
    user: basis.join("\n"),
    maxTokens: 400,
  });

  const suggestions: Suggestion[] = (out?.suggestions ?? [])
    .map((s) => ({ label: String(s.label ?? "").slice(0, 40), text: String(s.text ?? "").slice(0, 200) }))
    .filter((s) => s.label && s.text)
    .slice(0, 3);
  return { suggestions, basis };
}
