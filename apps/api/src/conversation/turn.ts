import type { Db } from "../db/index.js";
import type { LlmClient } from "../engine/llm.js";
import type { Embedder } from "../memory/embedder.js";
import { ingestText, searchMemory } from "../memory/store.js";
import { appendEvent, insertRun } from "../repo/runs.js";
import { getHistory, addMessage, setTitleIfDefault } from "./store.js";
import { classifyTurn, extractFacts, looksLikeTask, streamReply, type TurnPlan } from "./brain.js";
import { interpretPhoneQuery, isProductSearch } from "./products.js";
import { bus } from "./bus.js";

export interface TurnResult {
  pending?: { text: string; understood: string; canonical: string | null; issue: string | null } | null;
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

  // 1) пошук товару → спершу показуємо, ЯК зрозуміли, і чекаємо «так»
  const product = isProductSearch(text) ? interpretPhoneQuery(text) : null;
  if (product) {
    const body = product.issue
      ? `Я зрозумів: **${product.understood}**.\n\n${product.issue}\n\nПідкажіть правильний варіант — і я одразу почну пошук.`
      : `Я зрозумів: ви шукаєте **${product.understood}**.\n\nВсе вірно? Якщо так — натисніть «Почати пошук», і я перевірю ціни. Якщо ні — скажіть, що виправити.`;
    const msg = await db.tx(tenantId, (q) => addMessage(q, {
      tenantId, conversationId, role: "assistant", content: body, runId: null,
      meta: { intent: "confirm", pending: { text, understood: product.understood, canonical: product.canonical, issue: product.issue } },
    }));
    return { intent: "confirm", runId: null, messageId: msg.id, content: body,
      plan: undefined, options: ["Почати пошук", "Виправити"],
      pending: { text, understood: product.understood, canonical: product.canonical, issue: product.issue } };
  }

  // 2) корекція: «ти не так зрозумів» — не переказуємо, а питаємо точну назву
  if (/не так зрозум|ти не зрозумів|не те\b|помилив|я мав на увазі|неправильно зрозум/i.test(text)) {
    const body = "Вибачте. Що саме я пропустив? Напишіть точну назву моделі (наприклад, **iPhone SE 2020 256 ГБ**) — і я виправлю.";
    const msg = await db.tx(tenantId, (q) => addMessage(q, {
      tenantId, conversationId, role: "assistant", content: body, runId: null, meta: { intent: "correct" },
    }));
    return { intent: "correct", runId: null, messageId: msg.id, content: body };
  }

  // 3) звичайний шлях
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
