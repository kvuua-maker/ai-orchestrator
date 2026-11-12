import type { Plan } from "@aio/shared";
import { createLlm } from "./llm.js";
import { createPlanner as makePlanner } from "./planner.js";
import { heuristicGoal } from "./router.js";

/**
 * Сумісний фасад для старих тестів: prompt → план.
 * Всередині — Router (евристика) + Planner (LLM або евристика).
 */
export function createPlanner(opts: { apiKey?: string; baseUrl?: string; model?: string } = {}) {
  const llm = createLlm(opts);
  const planner = makePlanner(llm, ["http.fetch"]);
  return {
    name: planner.name,
    async plan({ prompt }: { prompt: string; budget?: unknown }): Promise<Plan> {
      return planner.plan(heuristicGoal(prompt), prompt);
    },
  };
}
export type Planner = ReturnType<typeof createPlanner>;
