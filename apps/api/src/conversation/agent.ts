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
  "http.fetch", "browser.open", "market.prices",
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
}

export interface AgentTurnResult {
  content: string;
  toolCalls: Array<{ name: string; ok: boolean }>;
  iterations: number;
  ms: number;
}

/** Короткий, але інформативний результат інструмента для моделі. */
function summarize(name: string, res: any): string {
  if (!res.ok) return `ПОМИЛКА ${res.error?.code}: ${String(res.error?.message ?? "").slice(0, 300)}`;
  const d = res.data ?? {};
  if (name === "market.prices") {
    const items = (d.items ?? []).slice(0, 10)
      .map((i: any) => `- ${i.price} грн | ${String(i.title).slice(0, 70)} | ${i.source} | ${i.url}`);
    return `${d.summary ?? ""}\nПосилання на оголошення (використовуй їх у таблиці):\n${items.join("\n")}`.slice(0, 4000);
  }
  if (d.prices?.length) return `ціни: ${d.prices.slice(0, 12).join(", ")}\n${String(d.text ?? "").slice(0, 1500)}`;
  if (d.text) return String(d.text).slice(0, 3000);
  if (d.hits) return (d.hits as any[]).slice(0, 5).map((h) => String(h.content).slice(0, 200)).join("\n");
  return JSON.stringify(d).slice(0, 2000);
}

export async function runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
  const t0 = Date.now();
  // DeepSeek вимагає ^[a-zA-Z0-9_-]+$ → крапки замінюємо підкресленнями і мапимо назад
  const toApi = (n: string) => n.replace(/\./g, "_");
  const fromApi = new Map<string, string>();

  const defs = input.tools.list()
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
  let content = "";
  let iterations = 0;
  const maxSteps = input.maxSteps ?? 5;

  for (let i = 0; i < maxSteps; i++) {
    iterations++;
    const r = await input.llm.chat({
      messages,
      tools: defs,
      maxTokens: 1400,
      temperature: 0.4,
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
      return { call, res, realName };
    }));

    for (const { call, res, realName } of results) {
      messages.push({ role: "tool", tool_call_id: call.id, content: summarize(realName, res) });
    }
  }

  return { content, toolCalls: used, iterations, ms: Date.now() - t0 };
}
