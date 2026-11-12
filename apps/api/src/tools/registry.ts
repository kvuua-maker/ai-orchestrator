import type { ToolDefinition, ToolResult } from "@aio/shared";

export interface ToolContext {
  tenantId: string;
  runId: string;
  taskId: string;
  dryRun: boolean;
  budgetUsd: number;
}

export interface Tool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
  simulate?(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): this {
    const name = tool.definition.name;
    if (this.tools.has(name)) throw new Error(`tool already registered: ${name}`);
    this.tools.set(name, tool);
    return this;
  }

  get(name: string): Tool {
    const t = this.tools.get(name);
    if (!t) throw new ToolNotFound(name);
    return t;
  }

  has(name: string): boolean { return this.tools.has(name); }

  list(): ToolDefinition[] { return [...this.tools.values()].map((t) => t.definition); }

  /** Права на рівні реєстру, не промпту (§3.2.1). */
  canInvoke(agent: string, toolName: string): boolean {
    const t = this.tools.get(toolName);
    if (!t) return false;
    return t.definition.allowedAgents.length === 0 || t.definition.allowedAgents.includes(agent);
  }

  async invoke(name: string, args: Record<string, unknown>, ctx: ToolContext, agent = "synthesizer"): Promise<ToolResult> {
    if (!this.canInvoke(agent, name)) {
      return { ok: false, error: { code: "POLICY_DENIED", message: `agent ${agent} may not use ${name}`, retryable: false } };
    }
    const tool = this.get(name);
    const fn = ctx.dryRun && tool.simulate ? tool.simulate : tool.execute;
    if (ctx.dryRun && !tool.simulate && tool.definition.effectClass !== "pure") {
      return { ok: false, error: { code: "DRY_RUN_UNSUPPORTED", message: `${name} has no simulate()`, retryable: false } };
    }
    return fn.call(tool, args, ctx);
  }
}

export class ToolNotFound extends Error {
  constructor(name: string) { super(`tool not found: ${name}`); this.name = "ToolNotFound"; }
}
