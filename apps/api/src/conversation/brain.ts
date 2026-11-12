import type { LlmClient } from "../engine/llm.js";
import { PERSONA, TOOLS_SUMMARY } from "./persona.js";

export type Intent = "answer" | "clarify" | "act";

export interface TurnPlan {
  intent: Intent;
  plan?: string[];
  options?: string[];      // залишено для сумісності, більше не генерується
  assumptions?: string[];
}

export interface HistoryItem { role: "user" | "assistant"; content: string }

const RE_FACT_HINT = /мене звати|мене зовут|мій |моя |моє |мої |постачальник|клієнт|працюю з|запам'ятай|наша компанія|наш |наше /i;

const SMALLTALK_RE = /^(бу+|ау|ей|привіт|прив|хай|добрий день|доброго дня|добрий вечір|вітаю|здоров|ок|окей|ага|так|ні|дякую|спасибі|thanks|hello|hi|hey|ти тут|є хто|чуєш)(?:\s|$|[!,.?])/iu;
const QUESTION_START = /^(що|шо|як|чому|навіщо|коли|де|хто|скільки|чи|можеш|можна|розкажи|поясни|what|why|how|can you)(?:\s|$|[,.?!])/iu;

/** Привітання й короткі репліки — не потребують ні LLM, ні задачі. */
export function isSmalltalk(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[!.…]+$/, "");
  return t.length <= 24 && (SMALLTALK_RE.test(t) || /^[\p{Emoji}\p{L}]{1,3}$/u.test(t));
}

/** Пряме питання — можна одразу відповідати, без окремого кроку класифікації. */
export function isDirectQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t.endsWith("?") || QUESTION_START.test(t);
}

const TASK_RE = /https?:\/\/|(перевір|знайди|зроби|порівняй|завантаж|розпізнай|зібери|порахуй|склади|проаналізуй|відкрий|оброби|експортуй|створи|підготуй|надішли|заповни)/i;

/** Очевидна задача — не витрачаємо круг LLM на класифікацію. */
export function looksLikeTask(text: string): boolean {
  return TASK_RE.test(text.trim());
}

/** Фаза 1: швидко визначити намір (маленька відповідь, без тексту). */
export async function classifyTurn(
  llm: LlmClient,
  input: { text: string; history: HistoryItem[] },
): Promise<TurnPlan> {
  const historyText = input.history.slice(-6)
    .map((m) => `${m.role === "user" ? "Клієнт" : "Ти"}: ${m.content.slice(0, 400)}`).join("\n");

  const out = await llm.json<Partial<TurnPlan>>({
    system: `Ти — диспетчер AI-Orchestrator. Визнач намір повідомлення клієнта.
Поверни ЛИШЕ JSON: {"intent":"answer|clarify|act","plan":["..."],"options":["..."]}
- answer — питання, порада, пояснення: нічого виконувати не треба.
- clarify — бракує даних (який сайт, період, формат).
- act — конкретна дія: перевірити сайт, розпізнати документ, зробити звіт.
plan — лише для act: 2–4 короткі кроки українською.
options — лише для clarify: 2–4 конкретні варіанти.`,
    user: historyText ? `Історія:\n${historyText}\n\nНове повідомлення:\n${input.text}` : input.text,
    maxTokens: 250,
  });

  // clarify більше не існує: будь-яка нечітка задача стає act із припущенням
  // ВАЖЛИВО: якщо модель не відповіла або відповіла нечітко — це answer, а не act.
  // Раніше невдача класифікації запускала задачу (run) на будь-яке «Бу» чи «привіт».
  const intent: Intent = out?.intent === "act" ? "act" : "answer";
  return {
    intent,
    plan: Array.isArray(out?.plan) ? out!.plan!.map(String).slice(0, 5) : undefined,
    assumptions: Array.isArray(out?.assumptions) ? out!.assumptions!.map(String).slice(0, 2) : undefined,
  };
}

/** Фаза 2: потокова відповідь людською мовою. */
export async function* streamReply(
  llm: LlmClient,
  input: { text: string; history: HistoryItem[]; plan: TurnPlan; facts: string[] },
): AsyncGenerator<string> {
  const historyText = input.history.slice(-8)
    .map((m) => `${m.role === "user" ? "Клієнт" : "Ти"}: ${m.content.slice(0, 500)}`).join("\n");

  const taskHint =
    input.plan.intent === "act"
      ? `Це задача з діями. Напиши 2–3 речення: що зрозумів і короткий план${input.plan.plan?.length ? ` (${input.plan.plan.join("; ")})` : ""}, і заверши словом «Починаю.»`
      : input.plan.intent === "clarify"
        ? `Бракує даних. Постав ОДНЕ коротке уточнююче питання (1–2 речення). Варіанти покаже інтерфейс, у тексті їх не перелічуй.`
        : `Це питання. Дай змістовну відповідь у Markdown (до 8 рядків), з конкретними прикладами.`;

  const factsBlock = input.facts.length
    ? `\n\n## Факти про клієнта (з твоєї пам'яті)\n${input.facts.map((f) => `- ${f}`).join("\n")}\n\nЯкщо у цих фактах є відповідь на питання — відповідай на їх основі. Не кажи «не знаю», якщо факт є вище.`
    : "";

  const userPrompt = `${historyText ? `Історія розмови:\n${historyText}\n\n` : ""}Нове повідомлення клієнта:\n${input.text}\n\n[Завдання: ${taskHint}]`;

  for await (const chunk of llm.stream({ system: `${PERSONA}\n\n${TOOLS_SUMMARY}${factsBlock}`, user: userPrompt, maxTokens: 900 })) {
    yield chunk;
  }
}

/** Витяг довготривалих фактів про клієнта (для пам'яті). */
export async function extractFacts(llm: LlmClient, text: string): Promise<string[]> {
  if (!RE_FACT_HINT.test(text) && text.length < 40) return [];
  const out = await llm.json<{ facts?: string[] }>({
    system: `Витягни з повідомлення факти про клієнта, які варто пам'ятати назавжди
(ім'я, компанія, постачальники, формати роботи, вподобання). Ігноруй разові задачі.
Поверни ЛИШЕ JSON: {"facts":["..."]}. Якщо фактів немає — {"facts":[]}.`,
    user: text,
    maxTokens: 200,
  });
  const facts = Array.isArray(out?.facts) ? out!.facts!.map(String).filter((f) => f.length > 3 && f.length < 200) : [];
  return facts.slice(0, 5);
}

/** Фінальний підсумок після виконання задачі. */
export async function* streamFinale(
  llm: LlmClient,
  input: { request: string; status: string; summary: string; findings: string[]; handoffQuestion?: string | null },
): AsyncGenerator<string> {
  const user = `Запит: ${input.request}
Статус: ${input.status}
Підсумок рушія: ${input.summary}
Знайдене: ${input.findings.slice(0, 5).join(" | ") || "—"}
${input.handoffQuestion ? `Питання до людини: ${input.handoffQuestion}` : ""}

Напиши клієнту підсумок у Markdown (3–6 рядків): що вийшло, які цифри/факти, що далі.`;

  for await (const chunk of llm.stream({
    system: `${PERSONA}\n\n${TOOLS_SUMMARY}\n\nТи щойно виконав задачу. Пиши лише підсумок, без плану.`,
    user, maxTokens: 500,
  })) {
    yield chunk;
  }
}
