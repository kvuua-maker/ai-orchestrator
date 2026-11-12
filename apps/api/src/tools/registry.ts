import type { ToolDefinition, ToolResult } from "@aio/shared";
import { maxSatisfying, compare, parseVersion } from "./semver.js";
import type { Tool, ToolContext } from "./sdk.js";

export type { Tool, ToolContext } from "./sdk.js";

export interface PolicyConfig {
  /** agent → дозволені інструменти (порожньо = без обмежень). */
  agentAllow?: Record<string, string[]>;
  /** tenant → дозволені інструменти (порожньо = без обмежень). */
  tenantAllow?: Record<string, string[]>;
  /** Ризики, які вимагають людського підтвердження. */
  requireApprovalFor?: Array<"write" | "destructive">;
  /** Стеля вартості одного виклику. */
  maxCostMicrosPerCall?: number;
  rateLimit?: { limit: number; windowMs: number };
}

export interface CatalogEntry {
  name: string;
  description: string;
  latest: string;
  versions: string[];
  risk: ToolDefinition["risk"];
  effectClass: ToolDefinition["effectClass"];
  costClass: ToolDefinition["costClass"];
  allowedAgents: string[];
  requiresApproval: boolean;
  supportsDryRun: boolean;
  deprecated?: { since: string; use?: string };
  inputSchema: Record<string, unknown>;
}

export class PolicyDenied extends Error {
  constructor(readonly reason: string, readonly tool: string) {
    super(`policy denied (${reason}): ${tool}`);
    this.name = "PolicyDenied";
  }
}

export class ToolNotFound extends Error {
  constructor(readonly name: string, readonly range: string) {
    super(`tool not found: ${name}@${range}`);
    this.name = "ToolNotFound";
  }
}

const COST_MICROS: Record<string, number> = { free: 0, cheap: 1_000, metered: 10_000, expensive: 100_000 };

export class ToolRegistry {
  private tools = new Map<string, Map<string, Tool>>();
  private hits = new Map<string, number[]>();
  policy: PolicyConfig = {};

  constructor(policy: PolicyConfig = {}) { this.policy = policy; }

  setPolicy(p: PolicyConfig): this { this.policy = p; return this; }

  register(tool: Tool): this {
    const { name, version } = tool.definition;
    if (!parseVersion(version)) throw new Error(`invalid semver: ${name}@${version}`);
    const versions = this.tools.get(name) ?? new Map<string, Tool>();
    if (versions.has(version)) throw new Error(`tool already registered: ${name}@${version}`);
    versions.set(version, tool);
    this.tools.set(name, versions);
    return this;
  }

  has(name: string): boolean { return this.tools.has(name); }

  versions(name: string): string[] {
    return [...(this.tools.get(name)?.keys() ?? [])].sort(compare);
  }

  /** Семвер-резолв: найвища версія в діапазоні, не-deprecated у пріоритеті. */
  resolve(name: string, range = "*"): Tool {
    const versions = this.tools.get(name);
    if (!versions) throw new ToolNotFound(name, range);
    const all = [...versions.keys()];
    const match = maxSatisfying(all, range);
    if (!match) throw new ToolNotFound(name, range);
    const tool = versions.get(match)!;
    if (tool.deprecated) {
      const nonDeprecated = all.filter((v) => !versions.get(v)!.deprecated);
      const better = maxSatisfying(nonDeprecated, range);
      if (better) return versions.get(better)!;
    }
    return tool;
  }

  list(): ToolDefinition[] {
    return [...this.tools.entries()].flatMap(([name, versions]) => {
      const latest = this.resolve(name);
      return [latest.definition];
    });
  }

  catalog(opts: { q?: string; agent?: string; risk?: string } = {}): CatalogEntry[] {
    const entries: CatalogEntry[] = [...this.tools.keys()].map((name) => {
      const latest = this.resolve(name);
      const d = latest.definition;
      return {
        name, description: d.description, latest: d.version, versions: this.versions(name),
        risk: d.risk, effectClass: d.effectClass, costClass: d.costClass,
        allowedAgents: d.allowedAgents, requiresApproval: d.requiresApproval,
        supportsDryRun: d.supportsDryRun, deprecated: latest.deprecated,
        inputSchema: d.inputSchema as Record<string, unknown>,
      };
    });
    return entries
      .filter((e) => !opts.q || `${e.name} ${e.description}`.toLowerCase().includes(opts.q.toLowerCase()))
      .filter((e) => !opts.agent || e.allowedAgents.length === 0 || e.allowedAgents.includes(opts.agent))
      .filter((e) => !opts.risk || e.risk === opts.risk)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Перевірка політики без виконання — для UI та аудиту. */
  checkPolicy(tool: Tool, ctx: ToolContext, agent: string): { ok: true } | { ok: false; reason: string } {
    const d = tool.definition;
    if (d.allowedAgents.length && !d.allowedAgents.includes(agent)) return { ok: false, reason: "agent_not_allowed" };

    // Якщо allowlist налаштований — це режим «за замовчуванням заборонено» (§7.4).
    const allowMap = this.policy.agentAllow;
    if (allowMap && Object.keys(allowMap).length) {
      const list = allowMap[agent];
      if (!list || !list.includes(d.name)) return { ok: false, reason: "agent_allowlist" };
    }
    const tenantMap = this.policy.tenantAllow;
    if (tenantMap && Object.keys(tenantMap).length) {
      const list = tenantMap[ctx.tenantId];
      if (!list || !list.includes(d.name)) return { ok: false, reason: "tenant_allowlist" };
    }

    const approval = this.policy.requireApprovalFor ?? [];
    if (approval.includes(d.risk as any) && !d.requiresApproval) return { ok: false, reason: "approval_required" };

    const cost = COST_MICROS[d.costClass] ?? 0;
    if (this.policy.maxCostMicrosPerCall !== undefined && cost > this.policy.maxCostMicrosPerCall) {
      return { ok: false, reason: "cost_ceiling" };
    }
    if (cost > 0 && ctx.budgetUsd <= 0) return { ok: false, reason: "budget_exhausted" };
    return { ok: true };
  }

  private rateLimited(key: string): boolean {
    const rl = this.policy.rateLimit;
    if (!rl) return false;
    const now = Date.now();
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < rl.windowMs);
    if (arr.length >= rl.limit) { this.hits.set(key, arr); return true; }
    arr.push(now);
    this.hits.set(key, arr);
    return false;
  }

  async invoke(name: string, args: unknown, ctx: ToolContext, agent = "synthesizer", opts: { version?: string } = {}): Promise<ToolResult> {
    let tool: Tool;
    try { tool = this.resolve(name, opts.version); }
    catch (e) {
      return { ok: false, error: { code: "NOT_FOUND", message: (e as Error).message, retryable: false } };
    }

    const policy = this.checkPolicy(tool, ctx, agent);
    if (!policy.ok) return { ok: false, error: { code: "POLICY_DENIED", message: policy.reason, retryable: false } };

    if (this.rateLimited(`${ctx.tenantId}:${name}`)) {
      return { ok: false, error: { code: "RATE_LIMIT", message: "rate limit exceeded", retryable: true } };
    }

    if (ctx.dryRun) {
      if (tool.simulate) return tool.simulate(args, ctx);
      if (tool.definition.effectClass !== "pure") {
        return { ok: false, error: { code: "DRY_RUN_UNSUPPORTED", message: `${name} has no simulate()`, retryable: false } };
      }
    }

    const attempts = Math.max(1, tool.definition.maxRetries + 1);
    let last: ToolResult = { ok: false, error: { code: "UPSTREAM_ERROR", message: "not executed", retryable: false } };
    for (let i = 0; i < attempts; i++) {
      last = await this.withTimeout(tool.execute(args, ctx), tool.definition.timeoutMs);
      if (last.ok) return last;
      if (!last.error.retryable) return last;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
    return last;
  }

  private async withTimeout(p: Promise<ToolResult>, ms: number): Promise<ToolResult> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<ToolResult>((resolve) => {
          timer = setTimeout(() => resolve({ ok: false, error: { code: "TIMEOUT", message: `timeout ${ms}ms`, retryable: true } }), ms);
        }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
