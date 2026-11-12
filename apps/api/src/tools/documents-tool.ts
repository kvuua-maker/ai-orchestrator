import { parseReceipt, needsConfirmation, type ParsedReceipt } from "@aio/documents";
import type { Tool } from "./registry.js";

/** OCR-вихід → структуровані поля + валідація (§13.5-13.7). */
export const documentsParseReceipt: Tool = {
  definition: {
    name: "documents.parseReceipt", version: "1.0.0",
    description: "Parse a Ukrainian fiscal receipt from OCR text: total, date, EDRPOU, VAT, items; validates arithmetic.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    outputSchema: { type: "object" },
    risk: "read", effectClass: "pure", costClass: "free",
    requiresApproval: false, requiredScopes: ["documents:read"],
    allowedAgents: ["data", "writer", "verifier", "synthesizer"],
    timeoutMs: 5_000, maxRetries: 0, supportsDryRun: true,
    idempotency: { strategy: "args_hash", ttlSeconds: 3600, onConflict: "return_cached" },
  },
  async execute(args) {
    const text = String(args.text ?? "");
    if (!text.trim()) return { ok: false, error: { code: "VALIDATION", message: "empty text", retryable: false } };
    const parsed: ParsedReceipt = parseReceipt(text);
    const confirm = needsConfirmation(parsed);
    return {
      ok: true, costMicros: 0, cached: false, dryRun: false,
      data: {
        total: parsed.total.value, date: parsed.date.value, edrpou: parsed.edrpou.value,
        vat: parsed.vat.value, items: parsed.items.length,
        quality: parsed.quality, issues: parsed.issues, needsConfirmation: confirm,
      },
      evidence: [{ quote: text.slice(0, 120), capturedAt: new Date().toISOString() }],
      artifacts: [],
    };
  },
  async simulate() {
    return { ok: true, costMicros: 0, cached: false, dryRun: true, data: { simulated: true }, evidence: [], artifacts: [] };
  },
};
