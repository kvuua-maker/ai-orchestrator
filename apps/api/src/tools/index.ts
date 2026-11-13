import type { Db } from "../db/index.js";
import type { Embedder } from "../memory/embedder.js";
import { ToolRegistry } from "./registry.js";
import { httpFetch } from "./http-fetch.js";
import { documentsParseReceipt, documentsProcess, documentsExport, documentsFolders } from "./documents-tool.js";
import { browserOpen } from "./browser-tool.js";
import { marketPrices } from "./market-tool.js";
import { companyLookup } from "./company-tool.js";
import { searchWeb } from "./search-tool.js";
import { telegramLookup } from "./telegram-tool.js";
import { edrLookup } from "./edr-tool.js";
import { vatCheck, fopLookup } from "./registry-tools.js";
import { courtSearch } from "./court-tool.js";
import { docCheck } from "./doccheck-tool.js";
import { createMemoryTools } from "./memory-tool.js";

export interface RegistryDeps { db?: Db; embedder?: Embedder }

export function createRegistry(deps: RegistryDeps = {}): ToolRegistry {
  const reg = new ToolRegistry()
    .register(httpFetch)
    .register(browserOpen)
    .register(marketPrices)
    .register(companyLookup)
    .register(searchWeb)
    .register(telegramLookup)
    .register(edrLookup)
    .register(vatCheck)
    .register(fopLookup)
    .register(courtSearch)
    .register(docCheck)
    .register(documentsParseReceipt)
    .register(documentsProcess)
    .register(documentsExport)
    .register(documentsFolders);
  if (deps.db) for (const tool of createMemoryTools(deps.db, deps.embedder)) reg.register(tool);
  return reg;
}

/** Базовий реєстр без пам'яті — для тестів і сценаріїв без БД. */
export const registry = createRegistry();

export { ToolRegistry } from "./registry.js";
export type { Tool, ToolContext } from "./sdk.js";
export { defineTool } from "./sdk.js";
