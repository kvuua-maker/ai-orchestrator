import type { GoalSpec } from "@aio/shared";
import type { LlmClient } from "./llm.js";

export interface RouteResult { goalSpec: GoalSpec; source: "llm" | "heuristic"; }

const URL_RE = /https?:\/\/[^\s)]+/g;

/** Евристика — працює без LLM і завжди дає валідний GoalSpec (§3.3.1). */
export function heuristicGoal(prompt: string): GoalSpec {
  const urls = prompt.match(URL_RE) ?? [];
  const lower = prompt.toLowerCase();
  const wantsSheet = /таблиц|excel|xlsx|csv|звіт у таблиц/.test(lower);
  const wantsDoc = /документ|pdf|звіт|report|презентац/.test(lower);
  const risky = /оплат|видали|delete|переказ|підпис|банк/.test(lower);

  const deliverables: GoalSpec["deliverables"] = [];
  if (wantsSheet) deliverables.push({ type: "spreadsheet", name: "result.xlsx" });
  else if (wantsDoc) deliverables.push({ type: "document", name: "result.pdf" });
  else deliverables.push({ type: "message", name: "answer" });

  return {
    objective: prompt.slice(0, 500),
    deliverables,
    constraints: { mustCiteSources: urls.length > 0, noLoginRequired: false, language: "uk" },
    acceptanceCriteria: [
      { id: "ac1", check: "non-empty summary", type: "deterministic" },
      ...(urls.length ? [{ id: "ac2", check: `fetched ${urls.length} source(s)`, type: "deterministic" as const }] : []),
      ...(wantsSheet ? [{ id: "ac3", check: "file with >=1 row", type: "deterministic" as const }] : []),
    ],
    riskLevel: risky ? "high" : "low",
    requiresConfirmation: risky,
  };
}

export function createRouter(llm: LlmClient = { name: "none", json: async () => null, stream: async function* () {} }) {
  return {
    name: llm.name === "none" ? "heuristic" : llm.name,
    async route(prompt: string): Promise<RouteResult> {
      const fallback = heuristicGoal(prompt);
      const out = await llm.json<Partial<GoalSpec>>({
        system: `Ти — Router RPA-агента. Поверни ЛИШЕ JSON:
{"objective":string,"deliverables":[{"type":"spreadsheet|document|pdf|data|message","name":string}],
 "riskLevel":"low|medium|high","requiresConfirmation":boolean,
 "acceptanceCriteria":[{"id":string,"check":string,"type":"deterministic"}]}
Правила: 1-2 deliverables; 1-3 acceptanceCriteria; жодних пояснень.`,
        user: prompt,
        maxTokens: 400,
      });
      if (!out?.objective) return { goalSpec: fallback, source: "heuristic" };
      const merged: GoalSpec = {
        ...fallback,
        objective: String(out.objective).slice(0, 500),
        deliverables: Array.isArray(out.deliverables) && out.deliverables.length ? out.deliverables.slice(0, 3) as GoalSpec["deliverables"] : fallback.deliverables,
        riskLevel: ["low", "medium", "high"].includes(String(out.riskLevel)) ? out.riskLevel as GoalSpec["riskLevel"] : fallback.riskLevel,
        requiresConfirmation: typeof out.requiresConfirmation === "boolean" ? out.requiresConfirmation : fallback.requiresConfirmation,
        acceptanceCriteria: Array.isArray(out.acceptanceCriteria) && out.acceptanceCriteria.length
          ? out.acceptanceCriteria.slice(0, 3).map((c: any, i) => ({ id: String(c?.id ?? `ac${i + 1}`), check: String(c?.check ?? "ok"), type: "deterministic" as const }))
          : fallback.acceptanceCriteria,
      };
      return { goalSpec: merged, source: "llm" };
    },
  };
}
