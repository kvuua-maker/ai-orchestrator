import type { ArtifactRef, TaskResult } from "@aio/shared";
import type { Db } from "../db/index.js";
import { appendEvent, getRun, insertTasks, setStatus, updateTask } from "../repo/runs.js";
import { httpFetchTool } from "./tools/http.js";
import { planFor } from "./planner.js";

export interface Engine {
  enqueue(runId: string, tenantId?: string): void;
  drain(): Promise<void>;
}

/** Один воркер, послідовно — скелет. У проді: pg-boss + N воркерів (§33.4). */
export function createEngine(db: Db): Engine {
  const pending: Promise<void>[] = [];

  async function execute(runId: string) {
    const run = await getRun(db, runId);
    if (!run || run.status === "cancelled") return;

    await setStatus(db, runId, "planning");
    const plan = planFor(run.prompt);
    await db.query("UPDATE runs SET plan=$2::jsonb, goal_spec=$3::jsonb WHERE id=$1", [
      runId, JSON.stringify(plan), JSON.stringify({
        objective: run.prompt,
        deliverables: [{ type: "message", name: "answer" }],
        constraints: { mustCiteSources: false, noLoginRequired: false, language: "uk" },
        acceptanceCriteria: [{ id: "ac1", check: "run completed", type: "deterministic" }],
        riskLevel: "low", requiresConfirmation: false,
      }),
    ]);
    await insertTasks(db, runId, plan.nodes);
    await appendEvent(db, runId, "plan.created", { planId: plan.planId, nodes: plan.nodes.length });
    await setStatus(db, runId, "running");

    const artifacts: ArtifactRef[] = [];
    let findings = "";

    for (const node of plan.nodes) {
      const cur = await getRun(db, runId);
      if (cur?.status === "cancelled") { await updateTask(db, node.id, "skipped"); return; }

      await updateTask(db, node.id, "running");
      await appendEvent(db, runId, "task.started", { taskId: node.id, agent: node.agent });

      if (node.tools.includes("http.fetch")) {
        const url = run.prompt.match(/https?:\/\/[^\s)]+/)?.[0] ?? "";
        await appendEvent(db, runId, "tool.called", { taskId: node.id, tool: "http.fetch", args: { url } });
        const started = Date.now();
        const res = await httpFetchTool.execute({ url });
        await appendEvent(db, runId, "tool.result", {
          taskId: node.id, tool: "http.fetch", ok: res.ok, ms: Date.now() - started,
          summary: res.ok ? `HTTP ${(res.data as any)?.status}` : res.error.code,
        });
        if (res.ok) findings = String((res.data as any)?.text ?? "").slice(0, 500);
        await updateTask(db, node.id, res.ok ? "done" : "failed");
      } else {
        await updateTask(db, node.id, "done");
      }
      await appendEvent(db, runId, "task.finished", { taskId: node.id });
    }

    const result: TaskResult = {
      status: "success",
      summary: findings ? `Отримано ${findings.length} символів із джерела.` : "Задачу виконано.",
      data: { findings: findings.slice(0, 200) },
      artifacts, evidence: [], blockers: [], nextHints: [],
      metrics: { steps: plan.nodes.length, tokens: 0, costUsd: 0.003, durationMs: 0 },
    };
    await db.query("UPDATE runs SET spent_usd = spent_usd + 0.003 WHERE id=$1", [runId]);
    await appendEvent(db, runId, "run.completed", { status: result.status });
    await setStatus(db, runId, "done", { result });
  }

  return {
    enqueue(runId: string) {
      const p = execute(runId)
        .catch(async (e) => {
          const msg = e instanceof Error ? e.message : String(e);
          await appendEvent(db, runId, "run.failed", { error: msg }).catch(() => {});
          await setStatus(db, runId, "failed", { error: msg }).catch(() => {});
        })
        .finally(() => { const i = pending.indexOf(p); if (i >= 0) pending.splice(i, 1); });
      pending.push(p);
    },
    async drain() { while (pending.length) await Promise.allSettled([...pending]); },
  };
}
