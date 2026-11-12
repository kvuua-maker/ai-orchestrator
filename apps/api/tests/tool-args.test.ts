import { describe, it, expect } from "vitest";
import type { TaskNode } from "@aio/shared";
import { inferToolArgs, inferableTools, ArgsUnavailable } from "../src/engine/tool-args.js";
import { createRegistry } from "../src/tools/index.js";

// db потрібен лише для реєстрації інструментів пам'яті; тут ми не викликаємо їх
const registry = createRegistry({ db: {} as any });
const node = (goal: string, tools: string[] = []): TaskNode => ({
  id: "tsk_1" as any, agent: "browser", goal, tools, dependsOn: [], parallelizable: false,
  fanOut: 1, acceptanceCriteria: [], estCostUsd: 0.001,
});

describe("Виведення аргументів інструментів", () => {
  it("http.fetch отримує url із кроку", () => {
    const args = inferToolArgs(registry, "http.fetch", node("Відкрий https://example.com/a"), "зроби звіт");
    expect(args.url).toBe("https://example.com/a");
  });

  it("http.fetch бере url із промпту, якщо в кроці немає", () => {
    const args = inferToolArgs(registry, "http.fetch", node("Відкрий сторінку"), "перевір https://b.example");
    expect(args.url).toBe("https://b.example");
  });

  it("documents.parseReceipt отримує text із мети кроку", () => {
    const args = inferToolArgs(registry, "documents.parseReceipt", node("Молоко 2 x 42.50 Всього 85.00"), "");
    expect(String(args.text)).toContain("Молоко");
  });

  it("memory.search отримує query", () => {
    const args = inferToolArgs(registry, "memory.search", node("знайти чек на молоко"), "");
    expect(args.query).toBe("знайти чек на молоко");
  });

  it("документний експорт без аргументів → чесна відмова", () => {
    expect(() => inferToolArgs(registry, "documents.export", node("зроби xlsx"), ""))
      .toThrow(ArgsUnavailable);
  });

  it("не передає зайвих полів", () => {
    const args = inferToolArgs(registry, "http.fetch", node("https://example.com"), "");
    expect(Object.keys(args)).toEqual(["url"]);
  });

  it("планувальник бачить лише інструменти з вивідними аргументами", () => {
    const names = inferableTools(registry);
    expect(names).toContain("http.fetch");
    expect(names).toContain("documents.parseReceipt");
    expect(names).not.toContain("documents.export");   // потребує rows/columns
    expect(names).not.toContain("documents.process");  // потребує artifact key
  });
});
