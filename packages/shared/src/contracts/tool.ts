import { z } from "zod";
import { SecretRef, Timestamp } from "./common.js";
import { ArtifactRef, Evidence } from "./run.js";

/** Клас ефекту визначає стратегію повторів (§20.2). */
export const EffectClass = z.enum(["pure", "idempotent", "non_idempotent", "destructive"]);
export type EffectClass = z.infer<typeof EffectClass>;

export const RiskClass = z.enum(["read", "write", "destructive"]);

/**
 * Аргумент, що містить СЕКРЕТ, завжди передається як референс.
 * Схема фізично не має поля для сирого пароля (§17.16.1, бар'єр 2).
 */
export const SecretArg = SecretRef;

export const ToolDefinition = z.object({
  name: z.string(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string().max(1200),
  inputSchema: z.record(z.unknown()),
  outputSchema: z.record(z.unknown()),
  risk: RiskClass,
  effectClass: EffectClass,
  costClass: z.enum(["free", "cheap", "metered", "expensive"]),
  requiresApproval: z.boolean().default(false),
  requiredScopes: z.array(z.string()).default([]),
  allowedAgents: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().default(45_000),
  maxRetries: z.number().int().min(0).max(5).default(2),
  /** Контракт тренувального режиму (§29.3): інструмент із side-effects мусить мати simulate. */
  supportsDryRun: z.boolean().default(false),
  idempotency: z
    .object({
      strategy: z.enum(["args_hash", "natural_key", "client_key", "none"]),
      keyFields: z.array(z.string()).optional(),
      ttlSeconds: z.number().int().positive().default(86400),
      onConflict: z.enum(["return_cached", "error", "ask_human"]).default("return_cached"),
    })
    .optional(),
});
export type ToolDefinition = z.infer<typeof ToolDefinition>;

export const ToolErrorCode = z.enum([
  "NOT_FOUND",
  "BLOCKED",
  "TIMEOUT",
  "AUTH",
  "VALIDATION",
  "RATE_LIMIT",
  "POLICY_DENIED",
  "SANDBOX_ERROR",
  "UPSTREAM_ERROR",
  "DRY_RUN_UNSUPPORTED",
]);
export type ToolErrorCode = z.infer<typeof ToolErrorCode>;

export const ToolResult = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    data: z.unknown(),
    evidence: z.array(Evidence).default([]),
    artifacts: z.array(ArtifactRef).default([]),
    costMicros: z.number().int().nonnegative().default(0),
    cached: z.boolean().default(false),
    dryRun: z.boolean().default(false),
  }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: ToolErrorCode,
      message: z.string(),
      hint: z.string().optional(),
      retryable: z.boolean().default(false),
      escalateTo: z.enum(["next_tier", "human", "different_model"]).optional(),
    }),
  }),
]);
export type ToolResult = z.infer<typeof ToolResult>;

export const ToolCall = z.object({
  tool: z.string(),
  args: z.record(z.unknown()),
  /** Обов'язково для side-effect інструментів. */
  idempotencyKey: z.string().optional(),
});
export type ToolCall = z.infer<typeof ToolCall>;

export const ToolInvocation = z.object({
  id: z.string(),
  runId: z.string(),
  taskId: z.string(),
  tool: z.string(),
  argsHash: z.string(),
  status: z.enum(["in_flight", "ok", "error", "skipped"]),
  costMicros: z.number().int().nonnegative().default(0),
  startedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
});
