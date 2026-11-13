import type { Db } from "../db/index.js";
import type { LlmClient } from "../engine/llm.js";
import type { Embedder } from "../memory/embedder.js";
import { ingestText, searchMemory } from "../memory/store.js";
import { appendEvent, insertRun } from "../repo/runs.js";
import { getHistory, addMessage, setTitleIfDefault } from "./store.js";
import { classifyTurn, extractFacts, isDirectQuestion, isSmalltalk, looksLikeTask, streamReply, type TurnPlan } from "./brain.js";
import { interpretPhoneQuery, isProductSearch } from "./products.js";
import { runAgentTurn } from "./agent.js";
import { bus } from "./bus.js";
import { PERSONA } from "./persona.js";

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
  engine: { enqueue(runId: string, tenantId: string): void; tools?: any; artifacts?: any },
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

  // 3) дрібні репліки — миттєво, без моделі
  if (isSmalltalk(text)) {
    const body = /бу+|ау|ей|чуєш|ти тут/i.test(text)
      ? "Я тут. Кажіть задачу — зроблю."
      : "Вітаю! Опишіть задачу — я складу план і виконаю.";
    const m = await db.tx(tenantId, (q) => addMessage(q, {
      tenantId, conversationId, role: "assistant", content: body, runId: null, meta: { intent: "smalltalk" },
    }));
    return { intent: "answer", runId: null, messageId: m.id, content: body };
  }

  // факти з пам'яті (впливають на системний промпт)
  let facts: Array<{ content: string }> = [];
  try {
    if (embedder) {
      const [vec] = await embedder.embed([text]);
      facts = await db.tx(tenantId, (q) => searchMemory(q, {
        embedding: Array.from(vec!), query: text, k: 5, threshold: 0.25,
      })) as any;
    }
  } catch { facts = []; }

  // 4) основний шлях: function calling — модель сама вирішує, відповісти чи діяти
  const messageId = `msg_a_${Date.now().toString(36)}`;
  bus.publish(conversationId, { type: "message.start", messageId, role: "assistant", meta: { intent: "answer" } });

  let streamed = "";
  const toolSteps: Array<{ label: string; status: string; icon: string }> = [];
  const agent = await runAgentTurn({
    llm, db: (fn: any) => db.tx(tenantId, fn), tools: engine.tools as any, tenantId, artifacts: engine.artifacts as any,
    history, facts: facts.map((f) => f.content),
    text,
    system: `${PERSONA}\n\n${facts.length ? `Факти про клієнта:\n${facts.map((f) => `- ${f.content}`).join("\n")}` : ""}`,
    onDelta: (t) => { streamed += t; bus.publish(conversationId, { type: "message.delta", messageId, text: t }); },
    onStep: (label, status) => {
      const icon = status === "done" ? "✓" : status === "failed" ? "✕" : "⏳";
      bus.publish(conversationId, { type: "step", runId: "chat", label, status, icon });
      toolSteps.push({ label, status, icon });
    },
  });

  const finalText = (agent.content || streamed || "").trim() || "Готовий. Опишіть задачу конкретніше — і я виконаю.";
  const msg = await db.tx(tenantId, (qq) => addMessage(qq, {
    tenantId, conversationId, role: "assistant", content: finalText, runId: null,
    meta: { intent: "answer", toolCalls: agent.toolCalls, iterations: agent.iterations },
  }));
  bus.publish(conversationId, { type: "message.done", messageId: msg.id, content: finalText,
    meta: { intent: "result", toolCalls: agent.toolCalls, iterations: agent.iterations } });
  return { intent: "answer", runId: null, messageId: msg.id, content: finalText };
}
