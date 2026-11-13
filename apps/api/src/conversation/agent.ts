import { zodToJsonSchema } from "zod-to-json-schema";
import type { QueryFn } from "../db/index.js";
import type { ChatMessage, LlmClient } from "../engine/llm.js";
import type { ToolRegistry } from "../tools/index.js";

/**
 * Ядро взаємодії: стандартний function calling.
 * Модель отримує ПОВНУ історію + опис інструментів і сама вирішує — відповісти чи діяти.
 * Ніяких окремих «планувальників» і DAG на шляху чату.
 */

const CHAT_TOOLS = new Set([
  "http.fetch", "browser.open", "market.prices", "company.lookup", "search.web",
  "memory.search", "memory.remember",
  "documents.process", "documents.parseReceipt", "documents.export",
]);

export interface AgentTurnInput {
  llm: LlmClient;
  db: QueryFn;
  tools: ToolRegistry;
  tenantId: string;
  artifacts: any;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  facts: string[];
  text: string;
  system: string;
  onDelta: (text: string) => void;
  onStep: (label: string, status: "running" | "done" | "failed") => void;
  maxSteps?: number;
  noTools?: boolean;
}

export interface AgentTurnResult {
  deadlineHit?: boolean;
  content: string;
  toolCalls: Array<{ name: string; ok: boolean }>;
  iterations: number;
  ms: number;
}

/** Прибирає HTML-сміття: модель має бачити текст, а не розмітку. */
function plain(text: string): string {
  return String(text)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Короткий, але інформативний результат інструмента для моделі. */
function summarize(name: string, res: any): string {
  if (!res.ok) {
    const code = String(res.error?.code ?? "ERROR");
    const hint = /BLOCKED|ANTIBOT|CAPTCHA|FORBIDDEN/i.test(code + String(res.error?.message ?? ""))
      ? " → джерело закрите, спробуй ІНШИЙ інструмент або джерело (наприклад company.lookup, market.prices, http.fetch на інший сайт). Не питай користувача."
      : "";
    return `ПОМИЛКА ${code}: ${String(res.error?.message ?? "").slice(0, 240)}${hint}`;
  }
  const d = res.data ?? {};
  if (name === "search.web") {
    const rows = (d.results ?? []).slice(0, 10).map((r: any) => `- ${r.title} | ${r.url} | ${r.snippet}`);
    return `Пошук «${d.query}» (${d.engine}, ${d.total}):\n${rows.join("\n")}`.slice(0, 4000);
  }
  if (name === "company.lookup") {
    const c = d.company;
    if (!d.found || !c) return `Не знайдено в джерелах: ${(d.tried ?? []).join(", ")}`;
    return [
      `Назва: ${c.name}`,
      c.edrpou ? `ЄДРПОУ: ${c.edrpou}` : null,
      c.address ? `Адреса: ${c.address}` : null,
      c.director ? `Керівник: ${c.director}` : null,
      c.activity ? `Діяльність: ${c.activity}` : null,
      c.registeredAt ? `Зареєстровано: ${c.registeredAt}` : null,
      `Джерело: ${c.source} — ${c.url}`,
    ].filter(Boolean).join("\n");
  }
  if (name === "market.prices") {
    const items = (d.items ?? []).slice(0, 10)
      .map((i: any) => `- ${i.price} грн | ${String(i.title).slice(0, 70)} | ${i.source} | ${i.url}`);
    return `${d.summary ?? ""}\nПосилання на оголошення (використовуй їх у таблиці):\n${items.join("\n")}`.slice(0, 4000);
  }
  if (d.prices?.length) return `ціни: ${d.prices.slice(0, 12).join(", ")}\n${String(d.text ?? "").slice(0, 1500)}`;
  if (d.text) {
    const t = plain(String(d.text));
    return t.length > 60 ? t.slice(0, 3000) : `сторінка без читабельного тексту (${String(d.status ?? "?")})`;
  }
  if (d.hits) return (d.hits as any[]).slice(0, 5).map((h) => String(h.content).slice(0, 200)).join("\n");
  return JSON.stringify(d).slice(0, 2000);
}

export async function runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
  const t0 = Date.now();
  // DeepSeek вимагає ^[a-zA-Z0-9_-]+$ → крапки замінюємо підкресленнями і мапимо назад
  const toApi = (n: string) => n.replace(/\./g, "_");
  const fromApi = new Map<string, string>();

  const defs = input.noTools ? [] : input.tools.list()
    .filter((t) => CHAT_TOOLS.has(t.name))
    .map((t) => ({
      type: "function" as const,
      function: {
        name: toApi(t.name),
        description: String(t.description ?? "").slice(0, 300),
        parameters: (t as any).inputSchema ?? { type: "object", properties: {} },
      },
    }));

  for (const d of defs) fromApi.set(d.function.name, d.function.name.replace(/_/g, "."));

  const messages: ChatMessage[] = [
    { role: "system", content: input.system },
    ...input.history.slice(-14).map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
    { role: "user", content: input.text },
  ];

  const used: Array<{ name: string; ok: boolean }> = [];
  const findings: string[] = [];
  let content = "";
  let iterations = 0;
  const maxSteps = input.maxSteps ?? 5;
  // жорсткий дедлайн на весь хід: краще відповісти частково, ніж отримати 524
  const DEADLINE_MS = Number(process.env.AGENT_DEADLINE_MS ?? 40_000);
  const deadline = t0 + DEADLINE_MS;
  let deadlineHit = false;

  for (let i = 0; i < maxSteps; i++) {
    if (Date.now() > deadline) { deadlineHit = true; break; }

    iterations++;
    const remainingMs = Math.max(5_000, Math.min(60_000, deadline - Date.now()));
    const r = await input.llm.chat({
      messages,
      tools: defs,
      maxTokens: 1400,
      temperature: 0.4,
      timeoutMs: Math.min(25_000, Math.max(6_000, deadline - Date.now())),
      onDelta: (t) => { if (t) input.onDelta(t); },
    });
    content = r.content;

    if (!r.toolCalls.length) break;

    messages.push({
      role: "assistant",
      content: r.content || null,
      tool_calls: r.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })),
    });

    // незалежні виклики в одному повідомленні — паралельно
    const results = await Promise.all(r.toolCalls.map(async (call) => {
      const realName = fromApi.get(call.name) ?? call.name.replace(/_/g, ".");
      input.onStep(`${realName}(${Object.keys(call.args).slice(0, 2).join(", ")})`, "running");
      let res: any;
      try {
        res = await input.tools.invoke(realName, call.args, {
          tenantId: input.tenantId, runId: "chat", taskId: `chat_${i}`,
          dryRun: false, budgetUsd: 0.5, artifacts: input.artifacts,
        }, "synthesizer");
      } catch (e: any) {
        res = { ok: false, error: { code: "TOOL_ERROR", message: String(e?.message ?? e) } };
      }
      input.onStep(`${realName} → ${res.ok ? "ок" : res.error?.code ?? "помилка"}`, res.ok ? "done" : "failed");
      used.push({ name: realName, ok: Boolean(res.ok) });
      if (res.ok) {
        const line = plain(summarize(realName, res).split("\n")[0] ?? "").slice(0, 220);
        if (line && !/^<!DOCTYPE|^<html|<script/i.test(line)) findings.push(line);
      }
      return { call, res, realName };
    }));

    for (const { call, res, realName } of results) {
      messages.push({ role: "tool", tool_call_id: call.id, content: summarize(realName, res) });
    }
  }

  if (deadlineHit) {
    const did = used.length ? `Встиг: ${[...new Set(used.map((u) => u.name))].join(", ")}.` : "";
    const got = findings.length ? `\n\nЩо вже є з джерел:\n${findings.slice(-2).map((f) => `• ${f}`).join("\n")}` : "";
    content = `${content.trim()}${got}\n\n—\n⏱ Зупинив роботу на ${Math.round(DEADLINE_MS / 1000)} с, щоб не вішати систему. ${did} Скажіть «продовж» — і я піду далі з цього місця.`.trim();
  } else if (!content.trim()) {
    content = used.length
      ? "Не встиг довести до кінця. Ось що вже перевірив — скажіть «продовж», і я піду далі."
      : "Не встиг відповісти за відведений час. Спробуйте сформулювати вужче — відповім швидко.";
  }
  return { content, toolCalls: used, iterations, ms: Date.now() - t0, deadlineHit };
}
