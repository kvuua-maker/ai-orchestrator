import type { LlmClient } from "../engine/llm.js";
import { PERSONA, TOOLS_SUMMARY } from "./persona.js";

export type Intent = "answer" | "clarify" | "act";

export interface TurnDecision {
  intent: Intent;
  reply: string;
  plan?: string[];
  options?: string[];
}

export interface HistoryItem { role: "user" | "assistant"; content: string }

/**
 * Один виклик LLM на хід: визначає намір і одразу пише відповідь.
 * JSON, бо нам потрібні структуровані plan/options, а не вільний текст.
 */
export async function decideTurn(
  llm: LlmClient,
  input: { text: string; history: HistoryItem[] },
): Promise<TurnDecision> {
  const historyText = input.history.slice(-8)
    .map((m) => `${m.role === "user" ? "Клієнт" : "Ти"}: ${m.content.slice(0, 600)}`)
    .join("\n");

  const out = await llm.json<Partial<TurnDecision>>({
    system: `${PERSONA}

${TOOLS_SUMMARY}

## Формат відповіді
Поверни ЛИШЕ JSON:
{
  "intent": "answer" | "clarify" | "act",
  "reply": "текст у Markdown, який побачить людина",
  "plan": ["крок 1", "крок 2"],        // тільки для intent=act
  "options": ["варіант 1", "варіант 2"] // тільки для intent=clarify
}

Правила вибору intent:
- answer — питання про тебе, порада, пояснення. Нічого виконувати не треба.
- clarify — бракує даних: незрозуміло який сайт, який період, який формат файлу.
- act — є конкретна дія: перевірити сайт, розпізнати документ, зробити звіт.

Для act у reply спочатку привітання-план: «Я зрозумів. План: ...» і заверши «Починаю.».
Не додавай у reply службових слів і не згадуй JSON.`,
    user: historyText ? `Історія розмови:\n${historyText}\n\nНове повідомлення клієнта:\n${input.text}` : input.text,
    maxTokens: 900,
  });

  const intent: Intent = out?.intent === "clarify" || out?.intent === "act" ? out.intent : "answer";
  const reply = String(out?.reply ?? "").trim();
  if (!reply) {
    return {
      intent: "answer",
      reply: "Вибачте, не зрозумів запит. Сформулюйте, будь ласка, інакше — або скажіть, що саме треба зробити.",
    };
  }
  return {
    intent, reply,
    plan: Array.isArray(out?.plan) ? out!.plan!.map(String).slice(0, 6) : undefined,
    options: Array.isArray(out?.options) ? out!.options!.map(String).slice(0, 4) : undefined,
  };
}

/** Фінальний підсумок після виконання задачі — теж людською мовою. */
export async function finalizeReply(
  llm: LlmClient,
  input: { request: string; status: string; summary: string; findings: string[]; handoffQuestion?: string | null },
): Promise<string> {
  const out = await llm.json<{ reply?: string }>({
    system: `${PERSONA}

${TOOLS_SUMMARY}

## Зараз
Ти щойно виконав задачу. Напиши клієнту підсумок у Markdown (3–6 рядків):
що вийшло, які цифри/факти отримано, що робити далі. Без технічних деталей.
Поверни ЛИШЕ JSON: {"reply": "..."}`,
    user: `Запит: ${input.request}
Статус: ${input.status}
Підсумок рушія: ${input.summary}
Знайдене: ${input.findings.slice(0, 5).join(" | ") || "—"}
${input.handoffQuestion ? `Питання до людини: ${input.handoffQuestion}` : ""}`,
    maxTokens: 600,
  });
  const reply = String(out?.reply ?? "").trim();
  if (reply) return reply;
  return input.status === "done"
    ? `Готово. ${input.summary}`
    : `Задача зупинилась: ${input.summary}`;
}
