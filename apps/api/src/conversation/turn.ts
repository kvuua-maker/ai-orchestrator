import type { Db } from "../db/index.js";
import type { LlmClient } from "../engine/llm.js";
import { appendEvent, insertRun } from "../repo/runs.js";
import { getHistory, addMessage, setTitleIfDefault } from "./store.js";
import { decideTurn } from "./brain.js";

export interface TurnResult {
  userMessage: { id: string; content: string };
  assistantMessage: { id: string; content: string; meta: Record<string, unknown> };
  runId: string | null;
  intent: string;
}

/**
 * Один хід діалогу: зберегти → зрозуміти → відповісти → (за потреби) запустити задачу.
 * Відповідь завжди є: навіть якщо задача піде у фон, людина одразу бачить план.
 */
export async function runTurn(
  db: Db,
  llm: LlmClient,
  engine: { enqueue(runId: string, tenantId: string): void },
  input: { tenantId: string; userId: string; conversationId: string; text: string },
): Promise<TurnResult> {
  const { tenantId, conversationId, text } = input;

  const history = await db.tx(tenantId, async (q) => {
    const h = await getHistory(q, conversationId, 12);
    await addMessage(q, { tenantId, conversationId, role: "user", content: text });
    await setTitleIfDefault(q, conversationId, text);
    return h.map((m) => ({ role: m.role === "assistant" ? "assistant" as const : "user" as const, content: m.content }));
  });

  const decision = await decideTurn(llm, { text, history });

  let runId: string | null = null;

  if (decision.intent === "act") {
    // Задача: створюємо run і одразу показуємо план, не чекаючи виконання
    const run = await db.tx(tenantId, async (q) => {
      const r = await insertRun(q, {
        tenantId, userId: input.userId, prompt: text,
        budget: { maxUsd: 0.5, maxDurationSeconds: 900, maxSteps: 40 }, dryRun: false,
      });
      await q("UPDATE runs SET conversation_id=$2 WHERE id=$1", [r.id, conversationId]);
      await appendEvent(q, r.id, "run.created", { prompt: text, fromConversation: conversationId });
      return r;
    });
    runId = run.id;
    engine.enqueue(run.id, tenantId);
  }

  const meta: Record<string, unknown> = {
    intent: decision.intent,
    plan: decision.plan ?? null,
    options: decision.options ?? null,
    runId,
  };

  const assistant = await db.tx(tenantId, (q) => addMessage(q, {
    tenantId, conversationId, role: "assistant", content: decision.reply, runId, meta: meta as Record<string, unknown>,
  }));

  return {
    userMessage: { id: "user", content: text },
    assistantMessage: { id: assistant.id, content: assistant.content, meta },
    runId,
    intent: decision.intent,
  };
}
