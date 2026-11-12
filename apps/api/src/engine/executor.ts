import type { TaskResult } from "@aio/shared";
import type { Db, QueryFn } from "../db/index.js";
import { appendEvent, getRun, insertTasks, setStatus, updateTask } from "../repo/runs.js";
import { httpFetchTool } from "./tools/http.js";
import { planFor } from "./planner.js";
import { createPlanner, type Planner } from "./llm-planner.js";

export interface Engine {
  enqueue(runId: string, tenantId: string): void;
  drain(): Promise<void>;
}

export function createEngine(db: Db, planner: Planner = createPlanner()): Engine {
  const pending: Promise<void>[] = [];

  async function step<T>(tenantId: string, fn: (q: QueryFn) => Promise<T>): Promise<T> {
    return db.tx(tenantId, fn); // кожен крок — окрема коротка транзакція (без довгих блокувань)
  }

  async function execute(runId: string, tenantId: string) {
    const run = await step(tenantId, (q) => getRun(q, runId));
    if (!run || run.status === "cancelled") return;

    await step(tenantId, (q) => setStatus(q, runId, "planning"));

    const plan = await planner.plan({ prompt: run.prompt, budget: run.budget as any });
    const goalSpec = {
      objective: run.prompt,
      deliverables: [{ type: "message", name: "answer" }],
      constraints: { mustCiteSources: false, noLoginRequired: false, language: "uk" },
      acceptanceCriteria: [{ id: "ac1", check: "run completed", type: "deterministic" }],
      riskLevel: "low", requiresConfirmation: false,
    };

    await step(tenantId, async (q) => {
      await q("UPDATE runs SET plan=$2::jsonb, goal_spec=$3::jsonb WHERE id=$1", [runId, JSON.stringify(plan), JSON.stringify(goalSpec)]);
      await insertTasks(q, runId, plan.nodes);
      await appendEvent(q, runId, "plan.created", { planId: plan.planId, nodes: plan.nodes.length, planner: planner.name });
      await setStatus(q, runId, "running");
    });

    let findings = "";
    for (const node of plan.nodes) {
      const cur = await step(tenantId, (q) => getRun(q, runId));
      if (cur?.status === "cancelled") { await step(tenantId, (q) => updateTask(q, node.id, "skipped")); return; }

      await step(tenantId, async (q) => {
        await updateTask(q, node.id, "running");
        await appendEvent(q, runId, "task.started", { taskId: node.id, agent: node.agent, goal: node.goal });
      });

      if (node.tools.includes("http.fetch")) {
        const url = String((node as any).inputUrl ?? run.prompt.match(/https?:\/\/[^\s)]+/)?.[0] ?? "");
        await step(tenantId, (q) => appendEvent(q, runId, "tool.called", { taskId: node.id, tool: "http.fetch", args: { url } }));
        const started = Date.now();
        const res = await httpFetchTool.execute({ url }); // мережа — поза транзакцією
        await step(tenantId, async (q) => {
          await appendEvent(q, runId, "tool.result", {
            taskId: node.id, tool: "http.fetch", ok: res.ok, ms: Date.now() - started,
            summary: res.ok ? `HTTP ${(res.data as any)?.status}` : (res as any).error.code,
          });
          await updateTask(q, node.id, res.ok ? "done" : "failed");
        });
        if (res.ok) findings = String((res.data as any)?.text ?? "").slice(0, 500);
      } else {
        await step(tenantId, (q) => updateTask(q, node.id, "done"));
      }
      await step(tenantId, (q) => appendEvent(q, runId, "task.finished", { taskId: node.id }));
    }

    const result: TaskResult = {
      status: "success",
      summary: findings ? `Отримано ${findings.length} символів із джерела.` : "Задачу виконано.",
      data: { findings: findings.slice(0, 200) },
      artifacts: [], evidence: [], blockers: [], nextHints: [],
      metrics: { steps: plan.nodes.length, tokens: 0, costUsd: 0.003, durationMs: 0 },
    };
    await step(tenantId, async (q) => {
      await q("UPDATE runs SET spent_usd = spent_usd + 0.003 WHERE id=$1", [runId]);
      await appendEvent(q, runId, "run.completed", { status: result.status });
      await setStatus(q, runId, "done", { result });
    });
  }

  return {
    enqueue(runId: string, tenantId: string) {
      const p = execute(runId, tenantId)
        .catch(async (e) => {
          const msg = e instanceof Error ? e.message : String(e);
          await step(tenantId, async (q) => {
            await appendEvent(q, runId, "run.failed", { error: msg }).catch(() => {});
            await setStatus(q, runId, "failed", { error: msg }).catch(() => {});
          }).catch(() => {});
        })
        .finally(() => { const i = pending.indexOf(p); if (i >= 0) pending.splice(i, 1); });
      pending.push(p);
    },
    async drain() { while (pending.length) await Promise.allSettled([...pending]); },
  };
}
