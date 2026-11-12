import type { GoalSpec, Plan, TaskNode } from "@aio/shared";
import { newId } from "../ids.js";
import type { LlmClient } from "./llm.js";

const URL_RE = /https?:\/\/[^\s)]+/g;

/** План без LLM: детермінований, завжди валідний DAG. */
export function heuristicPlan(goal: GoalSpec, prompt: string): Plan {
  const urls = [...new Set(prompt.match(URL_RE) ?? [])].slice(0, 4);
  const deliverable = goal.deliverables[0]?.type ?? "message";
  const nodes: TaskNode[] = [];

  if (urls.length) {
    for (const url of urls) {
      nodes.push({
        id: newId.task(), agent: "browser", goal: `Отримати ${url}`,
        tools: ["http.fetch"], dependsOn: [], parallelizable: true, fanOut: 1,
        acceptanceCriteria: [{ id: "ac", check: "status < 400", type: "deterministic" }],
        estCostUsd: 0.001,
      });
    }
  }

  const gatherIds = nodes.map((n) => n.id);
  nodes.push({
    id: newId.task(), agent: "data", goal: "Проаналізувати зібране",
    tools: [], dependsOn: gatherIds, parallelizable: false, fanOut: 1,
    acceptanceCriteria: [{ id: "ac", check: "analysis not empty", type: "deterministic" }],
    estCostUsd: 0.002,
  });
  const analyzeId = nodes.at(-1)!.id;

  nodes.push({
    id: newId.task(), agent: "writer", goal: `Сформувати ${deliverable}`,
    tools: [], dependsOn: [analyzeId], parallelizable: false, fanOut: 1,
    acceptanceCriteria: goal.acceptanceCriteria.slice(0, 2),
    estCostUsd: 0.002,
  });

  return {
    planId: newId.task(), version: 1, nodes,
    estimatedTotalUsd: nodes.reduce((s, n) => s + n.estCostUsd, 0),
    criticalPath: nodes.map((n) => n.id),
  };
}

const AGENTS = ["browser", "coder", "ops", "writer", "data", "verifier", "synthesizer"] as const;

export function createPlanner(llm: LlmClient, toolNames: string[]) {
  return {
    name: llm.name === "none" ? "heuristic" : llm.name,
    async plan(goal: GoalSpec, prompt: string): Promise<Plan> {
      const fallback = heuristicPlan(goal, prompt);
      const out = await llm.json<{ nodes?: any[] }>({
        system: `Ти — планувальник DAG для RPA-агента. Поверни ЛИШЕ JSON:
{"nodes":[{"agent":"browser|coder|ops|writer|data|verifier|synthesizer","goal":string,
"tools":string[],"dependsOn":number[],"estCostUsd":number}]}
Правила: 1-4 вузли, МІНІМУМ кроків (одна дія = один вузол); dependsOn — індекси попередніх вузлів; tools лише зі списку ${JSON.stringify(toolNames)};
Якщо в запиті одне посилання й одна дія — роби РІВНО ОДИН вузол (не додавай «перевірити», «проаналізувати», «підсумувати» окремими кроками);
Якщо в запиті немає джерела даних (ні посилання, ні файлу) і задача вимагає даних — один вузол: чесно сказати, що потрібні дані;
Для магазинів, маркетплейсів і SPA (rozetka, comfy, prom, epicentr тощо) ОБОВ'ЯЗКОВО browser.open, а не http.fetch;
для звичайних сторінок і API — http.fetch;
незалежні вузли не мають залежностей (вони виконуються паралельно); без пояснень.`,
        user: `Ціль: ${goal.objective}\nDeliverables: ${JSON.stringify(goal.deliverables)}\nЗапит: ${prompt.slice(0, 1500)}`,
        maxTokens: 900,
      });
      if (!Array.isArray(out?.nodes) || !out.nodes.length || out.nodes.length > 8) return fallback;

      const ids: string[] = [];
      const nodes: TaskNode[] = [];
      for (const [i, n] of out.nodes.entries()) {
        const id = newId.task(); ids.push(id);
        const deps = (Array.isArray(n?.dependsOn) ? n.dependsOn : [])
          .filter((d: any) => Number.isInteger(d) && d >= 0 && d < i).map((d: number) => ids[d]);
        nodes.push({
          id,
          agent: AGENTS.includes(n?.agent) ? n.agent : "synthesizer",
          goal: String(n?.goal ?? "крок").slice(0, 300),
          tools: (Array.isArray(n?.tools) ? n.tools : []).filter((t: any) => toolNames.includes(t)),
          dependsOn: deps, parallelizable: deps.length === 0, fanOut: 1,
          acceptanceCriteria: [{ id: "ac", check: "step completed", type: "deterministic" }],
          estCostUsd: Number.isFinite(n?.estCostUsd) ? Math.max(0, Number(n.estCostUsd)) : 0.001,
        });
      }
      const plan: Plan = {
        planId: newId.task(), version: 1, nodes,
        estimatedTotalUsd: nodes.reduce((s, x) => s + x.estCostUsd, 0),
        criticalPath: nodes.map((x) => x.id),
      };
      return isValidDag(plan) ? plan : fallback;
    },
  };
}

/** Kahn: чи це DAG без циклів і з валідними залежностями. */
export function isValidDag(plan: Plan): boolean {
  const ids = new Set(plan.nodes.map((n) => n.id));
  if (ids.size !== plan.nodes.length) return false;
  for (const n of plan.nodes) if (n.dependsOn.some((d) => !ids.has(d) || d === n.id)) return false;
  const indeg = new Map(plan.nodes.map((n) => [n.id, n.dependsOn.length]));
  const queue = plan.nodes.filter((n) => n.dependsOn.length === 0).map((n) => n.id);
  let seen = 0;
  while (queue.length) {
    const id = queue.shift()!; seen++;
    for (const n of plan.nodes) {
      if (n.dependsOn.includes(id)) {
        const d = indeg.get(n.id)! - 1; indeg.set(n.id, d);
        if (d === 0) queue.push(n.id);
      }
    }
  }
  return seen === plan.nodes.length;
}
