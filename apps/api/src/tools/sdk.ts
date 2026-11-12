import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDefinition, ToolResult, EffectClass } from "@aio/shared";
import type { ArtifactStore } from "../artifacts/store.js";

export interface ToolContext {
  tenantId: string;
  runId: string;
  taskId: string;
  dryRun: boolean;
  budgetUsd: number;
  artifacts?: ArtifactStore;
  signal?: AbortSignal;
}

export interface ToolSpec<I extends z.ZodTypeAny, O extends z.ZodTypeAny> {
  name: string;
  version: string;
  description: string;
  input: I;
  output?: O;
  risk: "read" | "write" | "destructive";
  effectClass: EffectClass;
  costClass: "free" | "cheap" | "metered" | "expensive";
  scopes?: string[];
  agents?: string[];
  timeoutMs?: number;
  maxRetries?: number;
  supportsDryRun?: boolean;
  idempotency?: ToolDefinition["idempotency"];
  deprecated?: { since: string; use?: string };
  execute(input: z.infer<I>, ctx: ToolContext): Promise<{ data: z.infer<O> | unknown; costMicros?: number; artifacts?: ToolResult extends { artifacts?: infer A } ? A : never }>;
  simulate?(input: z.infer<I>, ctx: ToolContext): Promise<unknown>;
}

export interface Tool {
  readonly definition: ToolDefinition;
  readonly inputZod: z.ZodTypeAny;
  readonly outputZod?: z.ZodTypeAny;
  readonly deprecated?: { since: string; use?: string };
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
  simulate?(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

/** Єдина точка опису інструмента: схема, політика, метадані (§3.2). */
export function defineTool<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(spec: ToolSpec<I, O>): Tool {
  const inputSchema = zodToJsonSchema(spec.input, { target: "jsonSchema7", $refStrategy: "none" }) as Record<string, unknown>;
  const { $schema, ...cleanInput } = inputSchema as any;
  const outputSchema = spec.output
    ? (zodToJsonSchema(spec.output, { target: "jsonSchema7", $refStrategy: "none" }) as Record<string, unknown>)
    : { type: "object" };

  const definition: ToolDefinition = {
    name: spec.name,
    version: spec.version,
    description: spec.description,
    inputSchema: cleanInput,
    outputSchema,
    risk: spec.risk,
    effectClass: spec.effectClass,
    costClass: spec.costClass,
    requiresApproval: spec.risk === "destructive" ? true : false,
    requiredScopes: spec.scopes ?? [],
    allowedAgents: spec.agents ?? [],
    timeoutMs: spec.timeoutMs ?? 30_000,
    maxRetries: spec.maxRetries ?? (spec.effectClass === "idempotent" || spec.effectClass === "pure" ? 2 : 0),
    supportsDryRun: spec.supportsDryRun ?? !!spec.simulate,
    idempotency: spec.idempotency,
  };

  const wrap = (fn: (input: any, ctx: ToolContext) => Promise<{ data: unknown; costMicros?: number; artifacts?: any } | unknown>, dryRun: boolean) =>
    async (input: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const parsed = spec.input.safeParse(input);
      if (!parsed.success) {
        return {
          ok: false, error: {
            code: "VALIDATION", retryable: false,
            message: `invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
          },
        };
      }
      const started = Date.now();
      try {
        const out: any = await fn(parsed.data, { ...ctx, dryRun });
        const payload = out && typeof out === "object" && "data" in out ? out : { data: out };
        if (spec.output && !dryRun) {   // simulate повертає прев'ю, а не реальний вихід
          const valid = spec.output.safeParse(payload.data);
          if (!valid.success) {
            return { ok: false, error: { code: "UPSTREAM_ERROR", retryable: false, message: `output schema violation: ${valid.error.issues[0]?.message}` } };
          }
        }
        return {
          ok: true,
          data: payload.data,
          costMicros: payload.costMicros ?? 0,
          cached: false,
          dryRun,
          evidence: [{ quote: `tool ${spec.name}@${spec.version} ran in ${Date.now() - started}ms`, capturedAt: new Date().toISOString() }],
          artifacts: payload.artifacts ?? [],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: { code: "UPSTREAM_ERROR", retryable: false, message: msg } };
      }
    };

  return {
    definition,
    inputZod: spec.input,
    outputZod: spec.output,
    deprecated: spec.deprecated,
    execute: wrap(spec.execute as any, false),
    simulate: spec.simulate ? wrap(spec.simulate as any, true) : undefined,
  };
}
