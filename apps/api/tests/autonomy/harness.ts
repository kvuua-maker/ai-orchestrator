import { z } from "zod";
import type { GoalSpec, Plan } from "@aio/shared";
import { buildApp } from "../../src/app.js";
import { createRegistry } from "../../src/tools/index.js";
import { defineTool, ToolFailure } from "../../src/tools/sdk.js";
import { heuristicGoal } from "../../src/engine/router.js";
import { newId } from "../../src/ids.js";
import type { Scenario } from "./scenarios.js";

export interface ScenarioOutcome {
  id: string; category: string; expect: Scenario["expect"]; actual: string;
  reason: string | null; handedOff: boolean; correct: boolean; ms: number; attempts: number;
}

/** Один app на весь прогін: інструмент читає поточний сценарій із замикання. */
export function createHarness() {
  let behaviour: Scenario["behaviour"] = { type: "ok" };
  let calls = 0;

  const probe = defineTool({
    name: "suite.probe", version: "1.0.0", description: "scenario probe",
    input: z.object({ url: z.string().optional() }).passthrough(),
    risk: "read", effectClass: "pure", costClass: "free", agents: [],
    timeoutMs: 2_000, maxRetries: 2,
    async execute() {
      calls++;
      switch (behaviour.type) {
        case "ok":
          return { data: { ok: true, calls } };
        case "failThenOk":
          if (calls <= behaviour.failures) throw new ToolFailure(behaviour.code, behaviour.message, true);
          return { data: { ok: true, calls } };
        case "always":
          throw new ToolFailure(behaviour.code, behaviour.message, behaviour.code === "TIMEOUT");
      }
    },
  });

  const registry = createRegistry().register(probe);

  const planner = {
    name: "suite",
    async plan(goal: GoalSpec, _prompt: string): Promise<Plan> {
      return {
        planId: "suite-plan", version: 1,
        nodes: [{
          id: newId.task(), agent: "browser", goal: goal.objective, tools: ["suite.probe"],
          dependsOn: [], parallelizable: false, fanOut: 1,
          acceptanceCriteria: [], estCostUsd: 0.001,
        }],
        estimatedTotalUsd: 0.001, criticalPath: [],
      };
    },
  };

  return {
    async init() {
      const app = await buildApp({
        engineDeps: {
          registry, planner,
          router: { name: "heuristic", async route(prompt: string) { return { goalSpec: heuristicGoal(prompt), source: "heuristic" }; } },
        },
      });
      await app.ready();
      return { app };
    },
    setScenario(s: Scenario) { behaviour = s.behaviour; calls = 0; },
    get attempts() { return calls; },
  };
}

export function summarise(outcomes: ScenarioOutcome[]) {
  const autoExpected = outcomes.filter((o) => o.expect === "auto");
  const autoOk = autoExpected.filter((o) => o.actual === "done");
  const escExpected = outcomes.filter((o) => o.expect === "human" || o.expect === "limit");
  const escOk = escExpected.filter((o) => o.correct);
  const failExpected = outcomes.filter((o) => o.expect === "fail");
  const failOk = failExpected.filter((o) => o.correct);
  const totalCorrect = outcomes.filter((o) => o.correct).length;

  return {
    total: outcomes.length,
    autonomy: {
      expected: autoExpected.length, achieved: autoOk.length,
      rate: autoExpected.length ? Math.round((autoOk.length / autoExpected.length) * 1000) / 10 : 0,
    },
    escalation: {
      expected: escExpected.length, correct: escOk.length,
      rate: escExpected.length ? Math.round((escOk.length / escExpected.length) * 1000) / 10 : 0,
    },
    deadEnds: {
      expected: failExpected.length, correct: failOk.length,
      rate: failExpected.length ? Math.round((failOk.length / failExpected.length) * 1000) / 10 : 0,
    },
    overall: { correct: totalCorrect, rate: Math.round((totalCorrect / outcomes.length) * 1000) / 10 },
    avgMs: Math.round(outcomes.reduce((s, o) => s + o.ms, 0) / outcomes.length),
  };
}
