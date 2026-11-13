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
  // картка потрібна лише якщо бракує обсягу пам'яті або комбінація неіснуюча
  if (product && (product.issue || !product.canonical)) {
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

  // 3.5) префетч для типових запитів: людина за ПІБ / компанія — одразу потрібне джерело
  let prefetched = "";
  const isCompany = /(тов|тзов|фоп|пат|єдрпоу|компані)/i.test(text);
  const nameMatch = text.match(/(?:^|[\s,.;:(])([А-ЯІЇЄҐ][а-яіїєґ’'\-]{2,})\s+([А-ЯІЇЄҐ][а-яіїєґ’'\-]{2,})(?:\s+([А-ЯІЇЄҐ][а-яіїєґ’'\-]{2,}))?/);
  try {
    if (isCompany) {
      const r = await (engine.tools as any).invoke("company.lookup", { query: text.slice(0, 120) }, {
        tenantId, runId: "chat", taskId: "prefetch", dryRun: false, budgetUsd: 0.3, artifacts: engine.artifacts,
      }, "synthesizer");
      if (r.ok && r.data?.found) {
        const c = r.data.company;
        prefetched = `Готові дані про компанію (використай їх у відповіді):\nНазва: ${c.name}\nЄДРПОУ: ${c.edrpou ?? "—"}\nАдреса: ${c.address ?? "—"}\nКерівник: ${c.director ?? "—"}\nДіяльність: ${c.activity ?? "—"}\nДжерело: ${c.source} ${c.url}`;
      }
    } else if (/(іпн|податков\w* номер|платник\w* пдв)/i.test(text)) {
      // запит про ІПН/ПДВ — спершу локальна база податкової
      const r = await (engine.tools as any).invoke("vat.check", { query: text.slice(0, 120) }, {
        tenantId, runId: "chat", taskId: "prefetch", dryRun: false, budgetUsd: 0.3, artifacts: engine.artifacts,
      }, "synthesizer");
      const code = text.match(/\b\d{10}\b/)?.[0];
      const r2 = code && !(r.ok && r.data?.found) ? await (engine.tools as any).invoke("vat.check", { query: code }, {
        tenantId, runId: "chat", taskId: "prefetch", dryRun: false, budgetUsd: 0.3, artifacts: engine.artifacts,
      }, "synthesizer") : r;
      const items = (r2.ok ? r2.data?.items ?? [] : []) as any[];
      if (items.length) {
        const body = `**Платник ПДВ — знайдено ${items.length}**\n\n`
          + items.slice(0, 5).map((i) => `- **${i.name}**\n  ІПН/код: \`${i.kod_pdv}\`\n  Зареєстровано платником: ${i.registered_at || "—"}${i.terminated_at ? `\n  Анульовано: ${i.terminated_at}` : ""}`).join("\n")
          + `\n\n_Джерело: офіційний реєстр платників ПДВ ДПС (локальна копія)._`;
        const m = await db.tx(tenantId, (q) => addMessage(q, {
          tenantId, conversationId, role: "assistant", content: body, runId: null, meta: { intent: "answer" },
        }));
        return { intent: "answer", runId: null, messageId: m.id, content: body };
      }
    } else if (nameMatch) {
      const r = await (engine.tools as any).invoke("search.web", { query: text.slice(0, 120), limit: 8 }, {
        tenantId, runId: "chat", taskId: "prefetch", dryRun: false, budgetUsd: 0.3, artifacts: engine.artifacts,
      }, "synthesizer");
      if (r.ok && r.data?.results?.length) {
        // для ПІБ відповідаємо детерміновано: швидко, з посиланнями, без блукання моделі
        const rows = r.data.results.slice(0, 8) as Array<{ title: string; url: string; snippet: string }>;
        const body = `**${nameMatch[0]} — що є у відкритих джерелах:**\n\n`
          + rows.map((x) => `- [${x.title.slice(0, 90)}](${x.url})${x.snippet ? `\n  ${x.snippet.slice(0, 160)}` : ""}`).join("\n")
          + `\n\n_Джерела: ${rows.length} результатів веб-пошуку. Якщо це не та людина — уточніть місто, компанію або рік народження._`;
        const m = await db.tx(tenantId, (q) => addMessage(q, {
          tenantId, conversationId, role: "assistant", content: body, runId: null,
          meta: { intent: "answer", sources: rows.map((x) => x.url) },
        }));
        return { intent: "answer", runId: null, messageId: m.id, content: body };
      }
    }
  } catch (e: any) { prefetched = ""; console.error("[prefetch]", e?.message ?? e); }

  // 4) основний шлях: function calling — модель сама вирішує, відповісти чи діяти
  const messageId = `msg_a_${Date.now().toString(36)}`;
  bus.publish(conversationId, { type: "message.start", messageId, role: "assistant", meta: { intent: "answer" } });

  let streamed = "";
  const toolSteps: Array<{ label: string; status: string; icon: string }> = [];
  const agent = await runAgentTurn({
    llm, db: (fn: any) => db.tx(tenantId, fn), tools: engine.tools as any, tenantId, artifacts: engine.artifacts as any,
    history, facts: facts.map((f) => f.content),
    text,
    noTools: Boolean(prefetched),
    system: `${PERSONA}\n\n${prefetched ? prefetched + "\n\nВідповідай ЛИШЕ на основі цих даних і дай посилання. Не викликай інші інструменти.\n\n" : ""}${facts.length ? `Факти про клієнта:\n${facts.map((f) => `- ${f.content}`).join("\n")}` : ""}`,
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
