import { randomBytes } from "node:crypto";

export const TRACE_HEADER = "x-trace-id";

export function newTraceId(): string {
  return `tr_${randomBytes(12).toString("hex")}`;
}

export function isValidTraceId(v: unknown): v is string {
  return typeof v === "string" && /^tr_[a-f0-9]{16,32}$/.test(v);
}

/** Структурований лог: один рядок JSON, зручно для Loki/CloudWatch (§22.3). */
export function logLine(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
}
