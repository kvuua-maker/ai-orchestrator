import type { Plan, TaskNode } from "@aio/shared";
import { newId } from "../ids.js";
import { planFor } from "./planner.js";

export interface Planner {
  readonly name: string;
  plan(input: { prompt: string; budget: unknown }): Promise<Plan>;
}

/**
 * DeepSeek-планувальник (§3.4). Якщо ключа немає або сервіс недоступний —
 * детермінований fallback, і це видно в події plan.created (planner: "stub").
 */
export function createPlanner(opts: { apiKey?: string; baseUrl?: string; model?: string } = {}): Planner {
  const apiKey = opts.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "";
  const baseUrl = opts.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
  const model = opts.model ?? process.env.DEEPSEEK_MODEL ?? "deepseek-chat";

  if (!apiKey) {
    return { name: "stub", async plan({ prompt }) { return planFor(prompt); } };
  }

  return {
    name: "deepseek",
    async plan({ prompt }) {
      const sys = `Ти — планувальник RPA-агента. Поверни ЛИШЕ JSON за схемою:
{"nodes":[{"agent":"browser|coder|ops|writer|data|verifier|synthesizer","goal":"...","tools":["http.fetch"],"dependsOn":[],"estCostUsd":0}]}
Правила: 1-4 задачі, мінімум кроків, максимум паралелізму, без пояснень поза JSON.`;
      try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model, temperature: 0.1, max_tokens: 700,
            response_format: { type: "json_object" },
            messages: [{ role: "system", content: sys }, { role: "user", content: prompt.slice(0, 4000) }],
          }),
          signal: AbortSignal.timeout(25_000),
        });
        if (!res.ok) throw new Error(`deepseek ${res.status}`);
        const body: any = await res.json();
        const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? "{}");
        const nodes: TaskNode[] = (parsed.nodes ?? [])
          .slice(0, 8)
          .map((n: any) => ({
            id: newId.task(),
            agent: ["browser", "coder", "ops", "writer", "data", "verifier", "synthesizer"].includes(n.agent) ? n.agent : "synthesizer",
            goal: String(n.goal ?? "крок").slice(0, 300),
            tools: Array.isArray(n.tools) ? n.tools.filter((t: any) => t === "http.fetch") : [],
            dependsOn: [], parallelizable: false, fanOut: 1,
            acceptanceCriteria: [{ id: "ac", check: "step completed", type: "deterministic" as const }],
            estCostUsd: Number(n.estCostUsd ?? 0.001),
          }));
        if (!nodes.length) throw new Error("empty plan");
        return { planId: newId.task(), version: 1, nodes, estimatedTotalUsd: nodes.reduce((s, n) => s + n.estCostUsd, 0), criticalPath: nodes.map((n) => n.id) };
      } catch {
        return planFor(prompt); // деградація без падіння run (§21.3)
      }
    },
  };
}
