import { ToolRegistry } from "./registry.js";
import { httpFetch } from "./http-fetch.js";
import { documentsParseReceipt } from "./documents-tool.js";

export const registry = new ToolRegistry().register(httpFetch).register(documentsParseReceipt);
export { ToolRegistry } from "./registry.js";
export type { Tool, ToolContext } from "./registry.js";
