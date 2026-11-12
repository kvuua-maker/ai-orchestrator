import { z } from "zod";
import { defineTool } from "./sdk.js";
import { parseReceipt, needsConfirmation, processDocument, exportFile, planFolders } from "@aio/documents";

const DocMeta = z.object({
  key: z.string(),
  name: z.string(),
  date: z.string().nullable().optional(),
  merchant: z.string().nullable().optional(),
  total: z.number().nullable().optional(),
  sha256: z.string(),
});

export const documentsParseReceipt = defineTool({
  name: "documents.parseReceipt",
  version: "1.1.0",
  description: "Parse a Ukrainian fiscal receipt from OCR text: total, date, EDRPOU, VAT, items; validates arithmetic.",
  input: z.object({ text: z.string().min(1) }),
  output: z.object({
    total: z.number().nullable(), date: z.string().nullable(), edrpou: z.string().nullable(),
    vat: z.number().nullable(), items: z.number(), quality: z.number(),
    issues: z.array(z.string()), needsConfirmation: z.array(z.string()),
  }),
  risk: "read", effectClass: "pure", costClass: "free",
  scopes: ["documents:read"], agents: ["data", "writer", "verifier", "synthesizer"],
  idempotency: { strategy: "args_hash", ttlSeconds: 3600, onConflict: "return_cached" },
  async execute({ text }) {
    const p = parseReceipt(text);
    return {
      data: {
        total: p.total.value, date: p.date.value, edrpou: p.edrpou.value, vat: p.vat.value,
        items: p.items.length, quality: p.quality, issues: p.issues, needsConfirmation: needsConfirmation(p),
      },
    };
  },
});

export const documentsProcess = defineTool({
  name: "documents.process",
  version: "1.0.0",
  description: "Run the full document pipeline on a stored artifact: detect type, extract text (PDF layer or OCR), parse and validate.",
  input: z.object({ key: z.string().length(64) }),
  output: z.object({
    status: z.enum(["promoted", "quarantined", "rejected"]),
    mime: z.string(), pages: z.number(), engine: z.string(), sha256: z.string(),
    reasons: z.array(z.string()), total: z.number().nullable(),
  }),
  risk: "read", effectClass: "pure", costClass: "free",
  scopes: ["documents:read"], agents: ["data", "verifier", "synthesizer"],
  timeoutMs: 60_000,
  async execute({ key }, ctx) {
    if (!ctx.artifacts) throw new Error("artifact store not available in context");
    const bytes = await ctx.artifacts.get(key);
    const r = await processDocument({ name: key, bytes });
    return {
      data: {
        status: r.status, mime: r.mime, pages: r.pages, engine: r.engine,
        sha256: r.sha256, reasons: r.reasons, total: r.parsed?.total.value ?? null,
      },
    };
  },
});

export const documentsExport = defineTool({
  name: "documents.export",
  version: "1.0.0",
  description: "Generate an xlsx, docx or pdf file from normalized rows and store it as an artifact.",
  input: z.object({
    format: z.enum(["xlsx", "docx", "pdf"]),
    title: z.string().min(1).max(120),
    columns: z.array(z.string()).min(1).max(20),
    rows: z.array(z.record(z.any())).max(5000),
  }),
  output: z.object({ key: z.string(), name: z.string(), mime: z.string(), bytes: z.number() }),
  risk: "read", effectClass: "idempotent", costClass: "free",
  scopes: ["documents:write"], agents: ["writer", "data", "synthesizer"],
  timeoutMs: 45_000,
  async execute(input, ctx) {
    if (!ctx.artifacts) throw new Error("artifact store not available in context");
    const file = await exportFile(input.format, { title: input.title, columns: input.columns, rows: input.rows as any });
    const stored = await ctx.artifacts.put({ bytes: file.bytes, mime: file.mime, name: file.name });
    return { data: { key: stored.key, name: file.name, mime: file.mime, bytes: stored.bytes } };
  },
});

export const documentsFolders = defineTool({
  name: "documents.folders",
  version: "1.0.0",
  description: "Plan folder placement for parsed documents (yyyy/mm/merchant) with deterministic collision handling.",
  input: z.object({ docs: z.array(DocMeta).max(2000), pattern: z.enum(["yyyy/mm/merchant", "yyyy/mm"]).optional() }),
  output: z.object({ moves: z.array(z.object({ from: z.string(), to: z.string(), reason: z.string() })), collisions: z.array(z.string()) }),
  risk: "read", effectClass: "pure", costClass: "free",
  scopes: ["documents:read"], agents: ["data", "ops", "writer", "synthesizer"],
  async execute({ docs, pattern }) {
    return { data: planFolders(docs as any, { pattern }) };
  },
});
