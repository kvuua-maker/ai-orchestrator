import { z } from "zod";

/** Branded identifiers — запобігають плутанині tenantId з runId на рівні типів. */
export const Id = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9a-z]{8,}$`), `expected ${prefix}_…`);

export const TenantId = Id("tnt");
export const UserId = Id("usr");
export const RunId = Id("run");
export const TaskId = Id("tsk");
export const SecretRef = Id("sec");
export const FileId = Id("fil");
export const DeviceId = Id("dev");

/** Час завжди ISO-8601 UTC. Клієнт ніколи не довіряє своєму годиннику (§34.4.4). */
export const Timestamp = z.string().datetime({ offset: true });

export const RunStatus = z.enum([
  "queued",
  "planning",
  "running",
  "awaiting_human",
  "verifying",
  "done",
  "failed",
  "cancelled",
  "stalled",
  "blocked",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const TaskStatus = z.enum(["pending", "running", "done", "failed", "skipped"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** Помилки API — машиночитні коди + людське повідомлення (§28.5). */
export const ErrorCode = z.enum([
  "VALIDATION_ERROR",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "IDEMPOTENCY_REPLAY",
  "POLICY_DENIED",
  "BUDGET_EXCEEDED",
  "RATE_LIMITED",
  "UPSTREAM_ERROR",
  "INTERNAL",
  "APP_VERSION_UNSUPPORTED",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiError = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    hint: z.string().optional(),
    details: z.record(z.unknown()).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

/** Курсор пагінації: (updated_at, id) — не offset (§34.4.4). */
export const Cursor = z.object({ updatedAt: Timestamp, id: z.string() });
export type Cursor = z.infer<typeof Cursor>;

export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  /** Delta sync: повернути лише змінені після цього моменту. */
  updated_since: Timestamp.optional(),
});
export type PageQuery = z.infer<typeof PageQuery>;

export const PageMeta = z.object({
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
  /** Клієнт використовує це як `updated_since` наступного разу. */
  server_time: Timestamp,
});

export const Budget = z.object({
  maxUsd: z.number().nonnegative(),
  maxDurationSeconds: z.number().int().positive(),
  maxSteps: z.number().int().positive().default(40),
});
export type Budget = z.infer<typeof Budget>;

/** Public shape — ніколи не містить секретів, лише референси. */
export const publicSafe = <T extends z.ZodTypeAny>(schema: T) => schema;
