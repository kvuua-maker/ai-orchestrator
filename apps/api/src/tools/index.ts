import { ToolRegistry } from "./registry.js";
import { httpFetch } from "./http-fetch.js";
import { documentsParseReceipt, documentsProcess, documentsExport, documentsFolders } from "./documents-tool.js";

export function createRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(httpFetch)
    .register(documentsParseReceipt)
    .register(documentsProcess)
    .register(documentsExport)
    .register(documentsFolders);
}

export const registry = createRegistry();

export { ToolRegistry } from "./registry.js";
export type { Tool, ToolContext } from "./sdk.js";
export { defineTool } from "./sdk.js";
