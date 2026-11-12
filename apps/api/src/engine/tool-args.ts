import type { TaskNode } from "@aio/shared";
import type { ToolRegistry } from "../tools/registry.js";

const URL_RE = /https?:\/\/[^\s)]+/;

export class ArgsUnavailable extends Error {
  constructor(readonly tool: string, readonly missing: string[]) {
    super(`${tool}: неможливо вивести аргументи (${missing.join(", ")})`);
    this.name = "ArgsUnavailable";
  }
}

/**
 * Виводить аргументи інструмента зі схеми та контексту кроку (§3.3.4).
 * Ніколи не передає зайвих полів: краще чесна відмова, ніж мовчазний збій.
 */
export function inferToolArgs(
  registry: ToolRegistry,
  toolName: string,
  node: TaskNode,
  runPrompt: string,
): Record<string, unknown> {
  const tool = registry.resolve(toolName);
  const schema = tool.definition.inputSchema as { properties?: Record<string, any>; required?: string[] };
  const props = Object.keys(schema.properties ?? {});
  const required = schema.required ?? [];
  const args: Record<string, unknown> = {};

  const url = node.goal.match(URL_RE)?.[0] ?? runPrompt.match(URL_RE)?.[0] ?? "";
  if (props.includes("url") && url) args.url = url;
  if (props.includes("text")) args.text = node.goal;
  if (props.includes("query")) args.query = node.goal;
  if (props.includes("k")) args.k = 5;
  if (props.includes("sourceType")) args.sourceType = "document";
  if (props.includes("sourceId")) args.sourceId = node.id;

  const missing = required.filter((k) => args[k] === undefined);
  if (missing.length) throw new ArgsUnavailable(toolName, missing);
  return args;
}

/** Інструменти, чиї аргументи можна вивести автоматично — лише їх бачить планувальник. */
export function inferableTools(registry: ToolRegistry): string[] {
  return registry.list()
    .filter((d) => {
      const schema = d.inputSchema as { properties?: Record<string, any>; required?: string[] };
      const required = schema.required ?? [];
      return required.every((k) => ["url", "text", "query", "k", "sourceType", "sourceId"].includes(k));
    })
    .map((d) => d.name);
}
