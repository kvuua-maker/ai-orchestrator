import type { Db } from "../db/index.js";
import type { LlmClient } from "../engine/llm.js";
import type { Embedder } from "../memory/embedder.js";
import { ingestText, searchMemory } from "../memory/store.js";
import { appendEvent, insertRun } from "../repo/runs.js";
import { getHistory, addMessage, setTitleIfDefault } from "./store.js";
import { classifyTurn, extractFacts, looksLikeTask, streamReply, type TurnPlan } from "./brain.js";
import { bus } from "./bus.js";

export interface TurnResult {
  intent: string;
  runId: string | null;
  messageId: string;
  content: string;
  plan?: string[];
  options?: string[];
}

/**
 * Один хід діалогу: класифікація → пам'ять → потокова відповідь → (за потреби) задача.
 * Текст віддається шматками через шину, а не одним блоком — це і є «живий» чат.
 */
export async function runTurn(
  db: Db,
  llm: LlmClient,
  embedder: Embedder | null,
  engine: { enqueue(runId: string, tenantId: string): void },
  input: { tenantId: string; userId: string; conversationId: string; text: string },
): Promise<TurnResult> {
  const { tenantId, conversationId, text } = input;

  const history = await db.tx(tenantId, async (q) => {
    const h = await getHistory(q, conversationId, 12);
    await addMessage(q, { tenantId, conversationId, role: "user", content: text });
    await setTitleIfDefault(q, conversationId, text);
    return h.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "assistant" as const : "user" as const, content: m.content }));
  });

  // швидкий шлях: явна задача стартує без окремого виклику класифікатора
  const plan: TurnPlan = looksLikeTask(text)
    ? { intent: "act" }
    : await classifyTurn(llm, { text, history });

  // факти про клієнта → у контекст
  let facts: string[] = [];
  if (embedder) {
    try {
      const [qv] = await embedder.embed([text]);
      const hits = await db.tx(tenantId, (q) => searchMemory(q, { embedding: Array.from(qv!), query: text, k: 4, threshold: 0.15 }));
      facts = hits.map((h) => h.content).slice(0, 4);
    } catch { facts = []; }
  }

  let runId: string | null = null;
  if (plan.intent === "act") {
    const run = await db.tx(tenantId, async (q) => {
      const r = await insertRun(q, { tenantId, userId: input.userId, prompt: text, budget: { maxUsd: 0.5, maxDurationSeconds: 900, maxSteps: 40 }, dryRun: false });
      await q("UPDATE runs SET conversation_id=$2 WHERE id=$1", [r.id, conversationId]);
      await appendEvent(q, r.id, "run.created", { prompt: text, fromConversation: conversationId });
      return r;
    });
    runId = run.id;
  }

  const messageId = `msg_live_${Date.now().toString(36)}`;
  bus.publish(conversationId, { type: "message.start", messageId, role: "assistant", meta: { intent: plan.intent, plan: plan.plan ?? null, options: plan.options ?? null, runId } });

  let content = "";
  for await (const chunk of streamReply(llm, { text, history, plan, facts })) {
    content += chunk;
    bus.publish(conversationId, { type: "message.delta", messageId, text: chunk });
  }
  if (!content.trim()) content = "Вибачте, не вдалося сформувати відповідь. Спробуйте ще раз.";

  const saved = await db.tx(tenantId, (q) => addMessage(q, {
    tenantId, conversationId, role: "assistant", content, runId,
    meta: { intent: plan.intent, plan: plan.plan ?? null, options: plan.options ?? null, runId },
  }));
  bus.publish(conversationId, { type: "message.done", messageId: saved.id, content, meta: saved.meta });

  if (runId) engine.enqueue(runId, tenantId);

  // пам'ять фактів — після відповіді, щоб не затримувати людину
  if (embedder) {
    extractFacts(llm, text).then(async (newFacts) => {
      for (const [i, f] of newFacts.entries()) {
        await db.tx(tenantId, (q) => ingestText(q, {
          tenantId, sourceType: "note", sourceId: `conv:${conversationId}:${Date.now()}:${i}`, text: f, embedder,
        })).catch(() => {});
      }
    }).catch(() => {});
  }

  return { intent: plan.intent, runId, messageId: saved.id, content, plan: plan.plan, options: plan.options };
}
