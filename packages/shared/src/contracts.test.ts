import { describe, it, expect } from "vitest";
import { GoalSpec, ToolDefinition, CreateRunRequest, RunEvent, MetaResponse } from "./index.js";

describe("contracts", () => {
  it("GoalSpec вимагає хоч один критерій приймання", () => {
    expect(GoalSpec.safeParse({ objective: "x", deliverables: [], constraints: {}, acceptanceCriteria: [] }).success).toBe(false);
  });
  it("GoalSpec приймає валідний мінімум", () => {
    expect(GoalSpec.safeParse({ objective: "Зробити звіт", deliverables: [{ type: "spreadsheet", name: "a.xlsx" }],
      constraints: {}, acceptanceCriteria: [{ id: "ac1", check: "rows>0", type: "deterministic" }] }).success).toBe(true);
  });
  it("ToolDefinition застосовує безпечні дефолти", () => {
    const t = ToolDefinition.parse({ name: "x.y", version: "1.0.0", description: "d", inputSchema: {}, outputSchema: {},
      risk: "destructive", effectClass: "destructive", costClass: "free" });
    expect(t.maxRetries).toBe(2);
    expect(t.supportsDryRun).toBe(false);
  });
  it("CreateRunRequest відхиляє порожній промпт", () => {
    expect(CreateRunRequest.safeParse({ prompt: "" }).success).toBe(false);
  });
  it("RunEvent: seq невідʼємний", () => {
    const base = { runId: "run_x", type: "run.created", createdAt: new Date().toISOString() };
    expect(RunEvent.safeParse({ ...base, seq: -1 }).success).toBe(false);
    expect(RunEvent.safeParse({ ...base, seq: 0 }).success).toBe(true);
  });
  it("MetaResponse: мобільні прапорці явні", () => {
    const m = MetaResponse.parse({ api_version: "1.0.0", server_time: new Date().toISOString(),
      min_app_version: "0.1.0", latest_app_version: "0.1.0",
      features: { sse: true, polling: true, presigned_upload: true, delta_sync: true, push: false, dry_run: true, mobile_auth: true },
      limits: { maxUploadMb: 25, maxPromptChars: 8000, maxRunsPerTenantConcurrent: 3 } });
    expect(m.features.polling).toBe(true);
  });
});
