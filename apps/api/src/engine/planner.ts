import type { Plan, TaskNode } from "@aio/shared";
import { newId } from "../ids.js";

/**
 * Заглушка планувальника (§24.3): детермінована, без LLM.
 * Реальний Planner з'явиться на тижні 3.
 */
export function planFor(prompt: string): Plan {
  const urlMatch = prompt.match(/https?:\/\/[^\s)]+/);
  const nodes: TaskNode[] = [];

  if (urlMatch) {
    nodes.push({
      id: newId.task(), agent: "browser", goal: `Отримати вміст ${urlMatch[0]}`,
      tools: ["http.fetch"], dependsOn: [], parallelizable: false, fanOut: 1,
      acceptanceCriteria: [{ id: "ac1", check: "status < 400", type: "deterministic" }],
      estCostUsd: 0.001,
    });
  }
  nodes.push({
    id: newId.task(), agent: "synthesizer", goal: "Сформувати відповідь",
    tools: [], dependsOn: nodes.map((n) => n.id), parallelizable: false, fanOut: 1,
    acceptanceCriteria: [{ id: "ac2", check: "non-empty summary", type: "deterministic" }],
    estCostUsd: 0.002,
  });

  return { planId: newId.task(), version: 1, nodes, estimatedTotalUsd: 0.003, criticalPath: nodes.map((n) => n.id) };
}
