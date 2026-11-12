import { describe, it, expect } from "vitest";
import type { Plan, TaskNode, TaskResult } from "@aio/shared";
import { heuristicGoal } from "../src/engine/router.js";
import { heuristicPlan, isValidDag } from "../src/engine/planner.js";
import { runPlan, topoWaves, CycleError } from "../src/engine/scheduler.js";
import { BudgetGuard, BudgetExceeded } from "../src/engine/budget.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createRouter } from "../src/engine/router.js";
import { createPlanner } from "../src/engine/planner.js";

const toolOk = { ok: true as const, data: {}, evidence: [], artifacts: [], costMicros: 0, cached: false, dryRun: false };
const ok = (s = "ok"): TaskResult => ({ status: "success", summary: s, artifacts: [], evidence: [], blockers: [], nextHints: [], metrics: { steps: 1, tokens: 0, costUsd: 0, durationMs: 0 } });
const node = (id: string, deps: string[] = [], extra: Partial<TaskNode> = {}): TaskNode => ({
  id: id as any, agent: "writer", goal: `g-${id}`, tools: [], dependsOn: deps as any, parallelizable: deps.length === 0,
  fanOut: 1, acceptanceCriteria: [], estCostUsd: 0.001, ...extra,
});
const plan = (nodes: TaskNode[]): Plan => ({ planId: "p", version: 1, nodes, estimatedTotalUsd: nodes.length * 0.001, criticalPath: [] });

describe("Router", () => {
  it("евристика: URL → data-джерело і цитати", () => {
    const g = heuristicGoal("Перевір https://a.com і https://b.com та зроби звіт");
    expect(g.constraints.mustCiteSources).toBe(true);
    expect(g.deliverables[0].type).toBe("document");
    expect(g.acceptanceCriteria.length).toBeGreaterThanOrEqual(2);
  });
  it("ризикова дія → high + confirmation", () => {
    const g = heuristicGoal("Зроби оплату рахунку");
    expect(g.riskLevel).toBe("high");
    expect(g.requiresConfirmation).toBe(true);
  });
  it("без LLM роутер працює (heuristic)", async () => {
    const r = createRouter();
    const out = await r.route("знайди ціну на https://shop.ua/item");
    expect(out.source).toBe("heuristic");
    expect(out.goalSpec.objective).toContain("shop.ua");
  });
});

describe("Planner", () => {
  it("DAG валідний і містить паралельні гілки для 2 URL", () => {
    const g = heuristicGoal("Порівняй https://a.com і https://b.com");
    const p = heuristicPlan(g, "Порівняй https://a.com і https://b.com");
    expect(isValidDag(p)).toBe(true);
    const roots = p.nodes.filter((n) => n.dependsOn.length === 0);
    expect(roots.length).toBe(2);
    expect(p.nodes.at(-1)!.dependsOn.length).toBe(1);
  });
  it("без URL — лінійний план із 2 кроків", () => {
    const g = heuristicGoal("Зроби висновок");
    const p = heuristicPlan(g, "Зроби висновок");
    expect(p.nodes.length).toBe(2);
    expect(isValidDag(p)).toBe(true);
  });
  it("isValidDag ловить цикл", () => {
    const p = plan([node("a", ["b"]), node("b", ["a"])]);
    expect(isValidDag(p)).toBe(false);
  });
  it("planner падає назад на евристику без LLM", async () => {
    const pl = createPlanner({ name: "none", json: async () => null }, ["http.fetch"]);
    const g = heuristicGoal("x https://a.com");
    const p = await pl.plan(g, "x https://a.com");
    expect(pl.name).toBe("heuristic");
    expect(isValidDag(p)).toBe(true);
  });
});

describe("Scheduler", () => {
  it("виконує незалежні вузли паралельно", async () => {
    const p = plan([node("a"), node("b"), node("c", ["a", "b"])]);
    let running = 0, peak = 0;
    const t0 = Date.now();
    const res = await runPlan(p, async (n) => {
      running++; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 120));
      running--;
      return ok(n.id);
    }, { concurrency: 3 });
    expect(peak).toBe(2);
    expect(Date.now() - t0).toBeLessThan(400);
    expect(res.completed.sort()).toEqual(["a", "b", "c"]);
  });

  it("поважає порядок залежностей", async () => {
    const p = plan([node("a"), node("b", ["a"]), node("c", ["b"])]);
    const order: string[] = [];
    await runPlan(p, async (n) => { order.push(n.id); return ok(); });
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("провал вузла → залежні skipped, решта виконується", async () => {
    const p = plan([node("a"), node("b"), node("c", ["a"]), node("d", ["b"])]);
    const res = await runPlan(p, async (n) => (n.id === "a" ? { ...ok(), status: "failed" as const } : ok()));
    expect(res.failed).toContain("a");
    expect(res.skipped).toContain("c");
    expect(res.completed).toContain("d");
  });

  it("цикл → CycleError", async () => {
    const p = plan([node("a", ["b"]), node("b", ["a"])]);
    await expect(runPlan(p, async () => ok())).rejects.toBeInstanceOf(CycleError);
  });

  it("topoWaves групує хвилі", () => {
    const p = plan([node("a"), node("b"), node("c", ["a", "b"]), node("d", ["c"])]);
    expect(topoWaves(p)).toEqual([["a", "b"], ["c"], ["d"]]);
  });
});

describe("BudgetGuard", () => {
  it("попереджає на 80% один раз", () => {
    const warns: number[] = [];
    const g = new BudgetGuard(1, (s) => warns.push(s.pct));
    g.charge(0.85); g.charge(0.05);
    expect(warns).toEqual([85]);
  });
  it("кидає BudgetExceeded при перевищенні", () => {
    const g = new BudgetGuard(0.1);
    expect(() => g.charge(0.2)).toThrow(BudgetExceeded);
  });
  it("canAfford враховує залишок", () => {
    const g = new BudgetGuard(1); g.charge(0.6);
    expect(g.canAfford(0.3)).toBe(true);
    expect(g.canAfford(0.5)).toBe(false);
  });
});

describe("ToolRegistry", () => {
  it("права агента перевіряються реєстром", async () => {
    const r = new ToolRegistry().register({
      definition: { name: "x.do", version: "1.0.0", description: "d", inputSchema: {}, outputSchema: {},
        risk: "read", effectClass: "pure", costClass: "free", requiresApproval: false,
        requiredScopes: [], allowedAgents: ["browser"], timeoutMs: 1000, maxRetries: 0, supportsDryRun: false },
      execute: async () => toolOk,
    });
    const denied = await r.invoke("x.do", {}, { tenantId: "t", runId: "r", taskId: "k", dryRun: false, budgetUsd: 1 }, "writer");
    expect(denied.ok).toBe(false);
    const allowed = await r.invoke("x.do", {}, { tenantId: "t", runId: "r", taskId: "k", dryRun: false, budgetUsd: 1 }, "browser");
    expect(allowed.ok).toBe(true);
  });
  it("dry-run без simulate → DRY_RUN_UNSUPPORTED", async () => {
    const r = new ToolRegistry().register({
      definition: { name: "w.do", version: "1.0.0", description: "d", inputSchema: {}, outputSchema: {},
        risk: "write", effectClass: "non_idempotent", costClass: "free", requiresApproval: false,
        requiredScopes: [], allowedAgents: [], timeoutMs: 1000, maxRetries: 0, supportsDryRun: false },
      execute: async () => toolOk,
    });
    const res = await r.invoke("w.do", {}, { tenantId: "t", runId: "r", taskId: "k", dryRun: true, budgetUsd: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("DRY_RUN_UNSUPPORTED");
  });
});
