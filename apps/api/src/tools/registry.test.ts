import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { defineTool, ToolRegistry } from "./index.js";
import { satisfies, maxSatisfying, compare } from "./semver.js";
import { createRegistry } from "./index.js";

const ctx = (over: Partial<any> = {}) => ({ tenantId: "tnt_demo0001", runId: "r", taskId: "k", dryRun: false, budgetUsd: 1, ...over });

const echo = (version: string, deprecated?: { since: string }) => defineTool({
  name: "test.echo", version, description: `echo ${version}`,
  input: z.object({ msg: z.string() }), output: z.object({ msg: z.string(), v: z.string() }),
  risk: "read", effectClass: "pure", costClass: "free", agents: [], deprecated,
  async execute({ msg }) { return { data: { msg, v: version } }; },
});

describe("semver", () => {
  it("compare", () => { expect(compare("1.2.3", "1.10.0")).toBeLessThan(0); });
  it("^ дотримується мажора", () => {
    expect(satisfies("1.5.0", "^1.0.0")).toBe(true);
    expect(satisfies("2.0.0", "^1.0.0")).toBe(false);
  });
  it("~ дотримується мінора", () => {
    expect(satisfies("1.2.9", "~1.2.0")).toBe(true);
    expect(satisfies("1.3.0", "~1.2.0")).toBe(false);
  });
  it("maxSatisfying бере найвищу", () => { expect(maxSatisfying(["1.0.0", "1.2.0", "2.0.0"], "^1")).toBe("1.2.0"); });
});

describe("ToolRegistry v2", () => {
  let reg: ToolRegistry;
  beforeEach(() => { reg = new ToolRegistry(); });

  it("реєструє кілька версій і резолвить найвищу", async () => {
    reg.register(echo("1.0.0")).register(echo("1.2.0")).register(echo("2.0.0"));
    expect(reg.versions("test.echo")).toEqual(["1.0.0", "1.2.0", "2.0.0"]);
    const r = await reg.invoke("test.echo", { msg: "hi" }, ctx(), "writer");
    expect(r.ok && (r.data as any).v).toBe("2.0.0");
  });

  it("діапазон версій у виклику", async () => {
    reg.register(echo("1.0.0")).register(echo("2.0.0"));
    const r = await reg.invoke("test.echo", { msg: "x" }, ctx(), "writer", { version: "^1" });
    expect(r.ok && (r.data as any).v).toBe("1.0.0");
  });

  it("deprecated поступається місцем не-deprecated", async () => {
    reg.register(echo("1.0.0", { since: "2026-01-01" })).register(echo("1.5.0"));
    const r = await reg.invoke("test.echo", { msg: "x" }, ctx(), "writer", { version: "^1" });
    expect(r.ok && (r.data as any).v).toBe("1.5.0");
  });

  it("валідація входу до виконання", async () => {
    reg.register(echo("1.0.0"));
    const r = await reg.invoke("test.echo", { msg: 123 }, ctx(), "writer");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
  });

  it("валідація виходу ловить зламаний інструмент", async () => {
    const broken = defineTool({
      name: "test.broken", version: "1.0.0", description: "b",
      input: z.object({}), output: z.object({ n: z.number() }),
      risk: "read", effectClass: "pure", costClass: "free", agents: [],
      async execute() { return { data: { n: "not-a-number" } }; },
    });
    reg.register(broken);
    const r = await reg.invoke("test.broken", {}, ctx(), "writer");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("UPSTREAM_ERROR");
  });

  it("політика агента блокує", async () => {
    reg.register(defineTool({
      name: "test.browser", version: "1.0.0", description: "b",
      input: z.object({}), risk: "read", effectClass: "pure", costClass: "free", agents: ["browser"],
      async execute() { return { data: {} }; },
    }));
    const r = await reg.invoke("test.browser", {}, ctx(), "writer");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("POLICY_DENIED");
  });

  it("tenant allowlist блокує", async () => {
    reg.register(echo("1.0.0"));
    reg.setPolicy({ tenantAllow: { tnt_other001: ["test.echo"] } });
    const r = await reg.invoke("test.echo", { msg: "x" }, ctx(), "writer");
    expect(r.ok).toBe(false);
  });

  it("кеп вартості блокує expensive", async () => {
    reg.register(defineTool({
      name: "test.expensive", version: "1.0.0", description: "x",
      input: z.object({}), risk: "read", effectClass: "pure", costClass: "expensive", agents: [],
      async execute() { return { data: {} }; },
    }));
    reg.setPolicy({ maxCostMicrosPerCall: 5_000 });
    const r = await reg.invoke("test.expensive", {}, ctx({ budgetUsd: 10 }), "writer");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe("cost_ceiling");
  });

  it("rate limit спрацьовує", async () => {
    reg.register(echo("1.0.0"));
    reg.setPolicy({ rateLimit: { limit: 2, windowMs: 10_000 } });
    await reg.invoke("test.echo", { msg: "1" }, ctx(), "writer");
    await reg.invoke("test.echo", { msg: "2" }, ctx(), "writer");
    const third = await reg.invoke("test.echo", { msg: "3" }, ctx(), "writer");
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.error.code).toBe("RATE_LIMIT");
  });

  it("таймаут повертає TIMEOUT, а не висить", async () => {
    reg.register(defineTool({
      name: "test.slow", version: "1.0.0", description: "s",
      input: z.object({}), risk: "read", effectClass: "pure", costClass: "free", agents: [], timeoutMs: 100, maxRetries: 0,
      async execute() { await new Promise((r) => setTimeout(r, 5000)); return { data: {} }; },
    }));
    const t0 = Date.now();
    const r = await reg.invoke("test.slow", {}, ctx(), "writer");
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("TIMEOUT");
  });

  it("dry-run без simulate → DRY_RUN_UNSUPPORTED", async () => {
    reg.register(defineTool({
      name: "test.write", version: "1.0.0", description: "w",
      input: z.object({}), risk: "write", effectClass: "non_idempotent", costClass: "free", agents: [],
      async execute() { return { data: {} }; },
    }));
    const r = await reg.invoke("test.write", {}, ctx({ dryRun: true }), "writer");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("DRY_RUN_UNSUPPORTED");
  });

  it("каталог фільтрує за агентом і ризиком", () => {
    const reg2 = createRegistry();
    const all = reg2.catalog();
    expect(all.length).toBeGreaterThanOrEqual(5);
    const browser = reg2.catalog({ agent: "browser" }).map((e) => e.name);
    expect(browser).toContain("http.fetch");
    const read = reg2.catalog({ risk: "read" });
    expect(read.every((e) => e.risk === "read")).toBe(true);
    const q = reg2.catalog({ q: "receipt" });
    expect(q[0]?.name).toBe("documents.parseReceipt");
  });

  it("каталог віддає JSON Schema входу", () => {
    const entry = createRegistry().catalog().find((e) => e.name === "http.fetch")!;
    expect(entry.inputSchema.type).toBe("object");
    expect((entry.inputSchema as any).properties.url.type).toBe("string");
  });
});
