import { z } from "zod";
import { Budget, RunId, Timestamp } from "./common.js";
import { GoalSpec, Plan, RunEvent, RunListItem, RunView, TaskView } from "./run.js";
import { ArtifactRef } from "./run.js";

/** Заголовок ідемпотентності для всіх POST (§20.10, §34.3 п.5). */
export const IDEMPOTENCY_HEADER = "idempotency-key";
export const API_VERSION = "1.0.0";
/** Мінімальна версія клієнта, яку ми ще підтримуємо (§34.4.7). */
export const MIN_APP_VERSION = "0.1.0";

/* ───────────────────────── meta ───────────────────────── */

export const MetaResponse = z.object({
  api_version: z.string(),
  server_time: Timestamp,
  min_app_version: z.string(),
  latest_app_version: z.string(),
  features: z.object({
    sse: z.boolean(),
    polling: z.boolean(),
    presigned_upload: z.boolean(),
    delta_sync: z.boolean(),
    push: z.boolean(),
    dry_run: z.boolean(),
    mobile_auth: z.boolean(),
  }),
  limits: z.object({
    maxUploadMb: z.number(),
    maxPromptChars: z.number(),
    maxRunsPerTenantConcurrent: z.number(),
  }),
});
export type MetaResponse = z.infer<typeof MetaResponse>;

/* ───────────────────────── runs ───────────────────────── */

export const CreateRunRequest = z.object({
  prompt: z.string().min(1).max(8000),
  /** Клієнт може передати власний GoalSpec (наприклад, із рецепта). */
  goalSpec: GoalSpec.partial().optional(),
  budget: Budget.partial().optional(),
  /** Тренувальний режим — нічого не змінюється назовні (§29.3). */
  dryRun: z.boolean().default(false),
  /** Рецепт, якщо запуск не з вільного тексту (§23.6). */
  recipeId: z.string().optional(),
  /** Продовження діалогу (§32.5). */
  conversationId: z.string().optional(),
});
export type CreateRunRequest = z.infer<typeof CreateRunRequest>;

export const CreateRunResponse = z.object({
  run: RunView,
  /** Чи був це повтор із тим самим Idempotency-Key. */
  replayed: z.boolean().default(false),
});
export type CreateRunResponse = z.infer<typeof CreateRunResponse>;

export const GetRunResponse = z.object({ run: RunView, tasks: z.array(TaskView) });
export type GetRunResponse = z.infer<typeof GetRunResponse>;

export const ListRunsResponse = z.object({
  items: z.array(RunListItem),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
  server_time: Timestamp,
});
export type ListRunsResponse = z.infer<typeof ListRunsResponse>;

export const EventsResponse = z.object({
  events: z.array(RunEvent),
  last_seq: z.number().int(),
  server_time: Timestamp,
});
export type EventsResponse = z.infer<typeof EventsResponse>;

export const CancelRunRequest = z.object({
  mode: z.enum(["soft", "hard"]).default("soft"),
  reason: z.string().optional(),
});
export type CancelRunRequest = z.infer<typeof CancelRunRequest>;

export const ApprovalRequest = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

/* ───────────────────────── uploads (§34.4.3) ───────────────────────── */

export const PresignRequest = z.object({
  filename: z.string().min(1).max(255),
  mime: z.string().min(3).max(128),
  sizeBytes: z.number().int().positive().max(25 * 1024 * 1024),
  sha256: z.string().length(64).optional(),
  /** partSize обрано клієнтом; сервер може скоригувати. */
  parts: z.number().int().positive().max(100).optional(),
});
export type PresignRequest = z.infer<typeof PresignRequest>;

export const PresignResponse = z.object({
  uploadId: z.string(),
  partSizeBytes: z.number().int().positive(),
  parts: z.array(z.object({ partNumber: z.number().int().positive(), url: z.string() })),
  expiresAt: Timestamp,
});
export type PresignResponse = z.infer<typeof PresignResponse>;

export const CompleteUploadRequest = z.object({
  parts: z.array(z.object({ partNumber: z.number().int().positive(), etag: z.string() })),
});
export type CompleteUploadRequest = z.infer<typeof CompleteUploadRequest>;

export const CompleteUploadResponse = z.object({
  fileId: z.string(),
  artifact: ArtifactRef,
});
export type CompleteUploadResponse = z.infer<typeof CompleteUploadResponse>;

/* ───────────────────────── devices / push (§34.4.5) ───────────────────────── */

export const RegisterDeviceRequest = z.object({
  platform: z.literal("ios"),
  apnsToken: z.string().min(32).max(512),
  appVersion: z.string(),
  osVersion: z.string().optional(),
  locale: z.enum(["uk", "en"]).default("uk"),
  timezone: z.string().default("Europe/Kiev"),
});
export type RegisterDeviceRequest = z.infer<typeof RegisterDeviceRequest>;

export const RegisterDeviceResponse = z.object({ deviceId: z.string() });

/* ───────────────────────── mobile auth (§34.4.1) ───────────────────────── */

export const TokenRequest = z.object({
  grant_type: z.enum(["authorization_code", "refresh_token"]),
  code: z.string().optional(),
  code_verifier: z.string().optional(),
  refresh_token: z.string().optional(),
  client_id: z.string().default("aio-ios"),
  redirect_uri: z.string().optional(),
});
export type TokenRequest = z.infer<typeof TokenRequest>;

export const TokenResponse = z.object({
  access_token: z.string(),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int(),
  refresh_token: z.string(),
  scope: z.string(),
});
export type TokenResponse = z.infer<typeof TokenResponse>;

export const CreateSecretRequest = z.object({
  kind: z.enum(["api_key", "password", "oauth_token", "totp"]),
  label: z.string().min(1).max(120),
  /** Тіло приймається лише цим ендпоінтом і ніколи не логується (§17.15). */
  value: z.string().min(1).max(8192),
});
export type CreateSecretRequest = z.infer<typeof CreateSecretRequest>;

export const CreateSecretResponse = z.object({
  secretRef: z.string(),
  masked: z.string(),
  fingerprint: z.string(),
  createdAt: Timestamp,
});

/* ───────────────────────── SSE ───────────────────────── */

export const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
} as const;

export const RunIdParam = z.object({ id: RunId });
