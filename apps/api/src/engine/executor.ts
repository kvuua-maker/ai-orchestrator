import type { GoalSpec, Plan, TaskNode, TaskResult } from "@aio/shared";
import type { Db, QueryFn } from "../db/index.js";
import { appendEvent, getRun, insertTasks, setStatus, updateTask } from "../repo/runs.js";
import { registry as defaultRegistry, type ToolRegistry } from "../tools/index.js";
import { BudgetExceeded, BudgetGuard } from "./budget.js";
import { createLlm, type LlmClient } from "./llm.js";
import { createPlanner } from "./planner.js";
import { createRouter } from "./router.js";
import { runPlan } from "./scheduler.js";

export interface Engine {
  enqueue(runId: string, tenantId: string): void;
  drain(): Promise<void>;
}

export interface EngineDeps {
  llm?: LlmClient;
  registry?: ToolRegistry;
  concurrency?: number;
}

const URL_RE = /https?:\/\/[^\s)]+/;

export function createEngine(db: Db, deps: EngineDeps = {}): Engine {
  const llm = deps.llm ?? createLlm();
  const tools = deps.registry ?? defaultRegistry;
  const router = createRouter(llm);
  const planner = createPlanner(llm, tools.list().map((t) => t.name));
  const concurrency = deps.concurrency ?? 3;
  const pending: Promise<void>[] = [];

  async function execute(runId: string, tenantId: string) {
    const step = <T>(fn: (q: QueryFn) => Promise<T>) => db.tx(tenantId, fn);

    const run = await step((q) => getRun(q, runId));
    if (!run || run.status === "cancelled") return;

    const budgetCfg = (run.budget ?? {}) as { maxUsd?: number };
    const guard = new BudgetGuard(Number(budgetCfg.maxUsd ?? 0.5), (snap) => {
      void step((q) => appendEvent(q, runId, "budget.warning", { ...snap })).catch(() => {});
    });

    await step((q) => setStatus(q, runId, "planning"));

    // 1. Router → GoalSpec
    const routed = await router.route(run.prompt);
    const goal: GoalSpec = routed.goalSpec;
    await step((q) => q("UPDATE runs SET goal_spec=$2::jsonb WHERE id=$1", [runId, JSON.stringify(goal)]));

    // 2. Planner → DAG
    const plan: Plan = await planner.plan(goal, run.prompt);
    await step(async (q) => {
      await q("UPDATE runs SET plan=$2::jsonb WHERE id=$1", [runId, JSON.stringify(plan)]);
      await insertTasks(q, runId, plan.nodes);
      await appendEvent(q, runId, "plan.created", {
        planId: plan.planId, nodes: plan.nodes.length,
        router: router.name, planner: planner.name,
        estimatedUsd: plan.estimatedTotalUsd, risk: goal.riskLevel,
      });
      await setStatus(q, runId, "running");
    });

    // 3. Scheduler → виконання DAG
    const findings: string[] = [];
    const schedule = await runPlan(plan, async (node: TaskNode): Promise<TaskResult> => {
      const t0 = Date.now();
      await step(async (q) => {
        await updateTask(q, node.id, "running");
        await appendEvent(q, runId, "task.started", { taskId: node.id, agent: node.agent, goal: node.goal });
      });

      const out: TaskResult = {
        status: "success", summary: node.goal, artifacts: [], evidence: [], blockers: [], nextHints: [],
        metrics: { steps: 0, tokens: 0, costUsd: 0, durationMs: 0 },
      };

      for (const toolName of node.tools) {
        const url = node.goal.match(URL_RE)?.[0] ?? run.prompt.match(URL_RE)?.[0] ?? "";
        await step((q) => appendEvent(q, runId, "tool.called", { taskId: node.id, tool: toolName, args: { url } }));
        const res = await tools.invoke(toolName, { url }, {
          tenantId, runId, taskId: node.id, dryRun: run.dry_run, budgetUsd: guard.snapshot().remainingUsd,
        }, node.agent);
        await step((q) => appendEvent(q, runId, "tool.result", {
          taskId: node.id, tool: toolName, ok: res.ok,
          summary: res.ok ? `ok` : res.error.code,
        }));
        if (res.ok) {
          const d = res.data as any;
          if (d?.text) findings.push(String(d.text).slice(0, 400));
          out.summary = `Отримано ${d?.bytes ?? 0} байт (HTTP ${d?.status ?? "?"})`;
        } else {
          out.status = "failed";
          out.blockers.push(res.error.message);
          out.summary = `Помилка ${res.error.code}: ${res.error.message}`;
        }
      }

      try {
        guard.charge(node.estCostUsd);
      } catch (e) {
        if (e instanceof BudgetExceeded) {
          out.status = "blocked";
          out.summary = "бюджет вичерпано";
          out.blockers.push(e.message);
        } else throw e;
      }

      out.metrics = { steps: 1, tokens: 0, costUsd: node.estCostUsd, durationMs: Date.now() - t0 };
      await step(async (q) => {
        await updateTask(q, node.id, out.status === "success" ? "done" : out.status === "failed" ? "failed" : "skipped");
        await appendEvent(q, runId, "task.finished", { taskId: node.id, status: out.status, ms: out.metrics.durationMs });
      });
      return out;
    }, {
      concurrency,
      onSkip: async (node, reason) => {
        await step(async (q) => {
          await updateTask(q, node.id, "skipped");
          await appendEvent(q, runId, "task.skipped", { taskId: node.id, reason });
        });
      },
    });

    // 4. Фінал
    const snap = guard.snapshot();
    const anyFailed = schedule.failed.length > 0;
    const status = anyFailed && schedule.completed.length === 0 ? "failed" : "done";
    const result: TaskResult = {
      status: anyFailed ? "partial" : "success",
      summary: anyFailed
        ? `Виконано ${schedule.completed.length}/${plan.nodes.length}, провалено ${schedule.failed.length}.`
        : `Готово: ${plan.nodes.length} кроків, $${snap.spentUsd.toFixed(4)}.`,
      data: { findings: findings.slice(0, 3), plan: plan.planId },
      artifacts: [], evidence: [], blockers: [], nextHints: [],
      metrics: { steps: plan.nodes.length, tokens: 0, costUsd: snap.spentUsd, durationMs: 0 },
    };

    await step(async (q) => {
      await q("UPDATE runs SET spent_usd=$2 WHERE id=$1", [runId, snap.spentUsd]);
      await appendEvent(q, runId, status === "done" ? "run.completed" : "run.failed", {
        status: result.status, spentUsd: snap.spentUsd, completed: schedule.completed.length, failed: schedule.failed.length,
      });
      await setStatus(q, runId, status, { result, error: anyFailed ? "partial failure" : undefined });
    });
  }

  return {
    enqueue(runId, tenantId) {
      const p = execute(runId, tenantId)
        .catch(async (e) => {
          const msg = e instanceof Error ? e.message : String(e);
          await db.tx(tenantId, async (q) => {
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
