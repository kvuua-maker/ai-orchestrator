import { z } from "zod";
import { Budget, RunStatus, TaskId, TaskStatus, Timestamp } from "./common.js";

/** Контракт успіху (§3.3.1). Без нього неможливий replan. */
export const AcceptanceCriterion = z.object({
  id: z.string(),
  check: z.string(),
  type: z.enum(["deterministic", "spot_check", "llm_judge"]),
  sample: z.number().int().positive().optional(),
});

export const GoalSpec = z.object({
  objective: z.string(),
  deliverables: z.array(
    z.object({
      type: z.enum(["spreadsheet", "document", "pdf", "image", "video", "data", "message", "file"]),
      name: z.string(),
      requiredColumns: z.array(z.string()).optional(),
    }),
  ),
  constraints: z.object({
    mustCiteSources: z.boolean().default(false),
    noLoginRequired: z.boolean().default(false),
    language: z.enum(["uk", "en"]).default("uk"),
  }),
  acceptanceCriteria: z.array(AcceptanceCriterion).min(1),
  riskLevel: z.enum(["low", "medium", "high"]).default("low"),
  requiresConfirmation: z.boolean().default(false),
});
export type GoalSpec = z.infer<typeof GoalSpec>;

export const AgentRole = z.enum([
  "browser",
  "coder",
  "ops",
  "writer",
  "data",
  "verifier",
  "synthesizer",
]);
export type AgentRole = z.infer<typeof AgentRole>;

export const TaskNode = z.object({
  id: TaskId,
  agent: AgentRole,
  goal: z.string(),
  tools: z.array(z.string()).default([]),
  dependsOn: z.array(TaskId).default([]),
  parallelizable: z.boolean().default(false),
  fanOut: z.number().int().min(1).max(32).default(1),
  outputSchema: z.record(z.unknown()).optional(),
  acceptanceCriteria: z.array(AcceptanceCriterion).default([]),
  estCostUsd: z.number().nonnegative().default(0),
});
export type TaskNode = z.infer<typeof TaskNode>;

export const Plan = z.object({
  planId: z.string(),
  version: z.number().int().positive().default(1),
  nodes: z.array(TaskNode).min(1),
  estimatedTotalUsd: z.number().nonnegative().default(0),
  /** Заповнюється детермінованим scheduler'ом, не моделлю. */
  criticalPath: z.array(TaskId).default([]),
});
export type Plan = z.infer<typeof Plan>;

/** Доказова база — без неї верифікатор не працює (§3.5.3). */
export const Evidence = z.object({
  url: z.string().url().optional(),
  quote: z.string().optional(),
  artifactKey: z.string().optional(),
  capturedAt: Timestamp,
});

export const ArtifactRef = z.object({
  key: z.string(),
  kind: z.enum(["file", "image", "pdf", "sheet", "doc", "video", "audio"]),
  bytes: z.number().int().nonnegative(),
  mime: z.string(),
  sha256: z.string().length(64).optional(),
});
export type ArtifactRef = z.infer<typeof ArtifactRef>;

export const TaskResult = z.object({
  status: z.enum(["success", "partial", "failed", "blocked"]),
  summary: z.string().max(4000),
  data: z.unknown().optional(),
  artifacts: z.array(ArtifactRef).default([]),
  evidence: z.array(Evidence).default([]),
  metrics: z.object({
    steps: z.number().int().nonnegative().default(0),
    tokens: z.number().int().nonnegative().default(0),
    costUsd: z.number().nonnegative().default(0),
    durationMs: z.number().int().nonnegative().default(0),
  }),
  blockers: z.array(z.string()).default([]),
  nextHints: z.array(z.string()).default([]),
});
export type TaskResult = z.infer<typeof TaskResult>;

/** Схема подій (§35.2) — джерело істини для SSE, polling і replay. */
export const RunEventType = z.enum([
  "run.created",
  "plan.created",
  "plan.revised",
  "task.started",
  "task.finished",
  "task.failed",
  "step.decision",
  "tool.called",
  "tool.result",
  "model.usage",
  "browser.tier",
  "approval.requested",
  "approval.resolved",
  "handoff.session",
  "budget.warning",
  "artifact.created",
  "output.transformed",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.stalled",
]);
export type RunEventType = z.infer<typeof RunEventType>;

export const RunEvent = z.object({
  seq: z.number().int().nonnegative(),
  runId: z.string(),
  type: RunEventType,
  payload: z.record(z.unknown()).default({}),
  createdAt: Timestamp,
});
export type RunEvent = z.infer<typeof RunEvent>;

/** Публічне подання run — те, що бачить веб і мобільний клієнт. */
export const RunView = z.object({
  id: z.string(),
  status: RunStatus,
  prompt: z.string(),
  goalSpec: GoalSpec.nullable(),
  plan: Plan.nullable(),
  budget: Budget,
  spentUsd: z.number().nonnegative(),
  progress: z.object({
    tasksTotal: z.number().int().nonnegative(),
    tasksDone: z.number().int().nonnegative(),
    currentTaskId: TaskId.nullable(),
  }),
  result: TaskResult.nullable(),
  error: z.string().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
});
export type RunView = z.infer<typeof RunView>;

export const RunListItem = RunView.pick({
  id: true,
  status: true,
  prompt: true,
  spentUsd: true,
  createdAt: true,
  updatedAt: true,
  finishedAt: true,
});
export type RunListItem = z.infer<typeof RunListItem>;

export const TaskView = z.object({
  id: TaskId,
  status: TaskStatus,
  agent: AgentRole,
  goal: z.string(),
  estCostUsd: z.number(),
  startedAt: Timestamp.nullable(),
  finishedAt: Timestamp.nullable(),
});
