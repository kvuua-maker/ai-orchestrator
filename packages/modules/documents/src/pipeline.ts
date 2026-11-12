import { createHash } from "node:crypto";
import { checkSize, detectMime } from "./mime.js";
import type { OcrEngine } from "./ocr.js";
import { textLayerEngine } from "./ocr.js";
import { parseReceipt, type ParsedReceipt } from "./receipt.js";
import { validateReceipt, type ValidationResult } from "./validate.js";

export type PipelineStatus = "promoted" | "quarantined" | "rejected";

export interface PipelineResult {
  name: string;
  mime: string;
  bytes: number;
  sha256: string;
  pages: number;
  text: string;
  parsed: ParsedReceipt | null;
  validation: ValidationResult | null;
  status: PipelineStatus;
  reasons: string[];
  engine: string;
}

export interface PipelineDeps {
  ocr?: OcrEngine;
  maxBytes?: number;
  now?: Date;
}

/** PDF із текстовим шаром: OCR не потрібен (§13.4). */
export async function extractPdfText(input: Uint8Array): Promise<{ text: string; pages: number }> {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdfjs вимагає саме Uint8Array, а Buffer — підклас із іншим конструктором
  const data = input.constructor === Uint8Array ? input : new Uint8Array(input);
  const task = pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false });
  const doc = await task.promise;
  try {
    const parts: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      parts.push(content.items.map((it: any) => it.str ?? "").join(" "));
    }
    return { text: parts.join("\n").replace(/[ \t]+/g, " ").trim(), pages: doc.numPages };
  } finally {
    await task.destroy();   // у pdfjs 6 прибирання — на loadingTask, не на документі
  }
}

async function extractText(file: { bytes: Uint8Array; mime: string; name: string }, deps: PipelineDeps) {
  const ocr = deps.ocr;
  if (file.mime === "text/plain") {
    return { text: new TextDecoder().decode(file.bytes), pages: 1, engine: "text-layer" };
  }
  if (file.mime === "application/pdf") {
    const { text, pages } = await extractPdfText(file.bytes);
    if (text.replace(/\s/g, "").length >= 20) return { text, pages, engine: "pdf-text-layer" };
    if (!ocr) throw new Error("pdf_has_no_text_layer_and_no_ocr");
    const o = await ocr.recognize({ bytes: file.bytes, mime: file.mime });
    return { text: o.text, pages: o.pages, engine: ocr.name };
  }
  if (file.mime.startsWith("image/")) {
    if (!ocr) throw new Error("image_requires_ocr_engine");
    const o = await ocr.recognize({ bytes: file.bytes, mime: file.mime });
    return { text: o.text, pages: 1, engine: ocr.name };
  }
  if (!ocr) {
    const o = await textLayerEngine.recognize({ bytes: file.bytes, mime: file.mime });
    return { text: o.text, pages: o.pages, engine: textLayerEngine.name };
  }
  const o = await ocr.recognize({ bytes: file.bytes, mime: file.mime });
  return { text: o.text, pages: o.pages, engine: ocr.name };
}

/**
 * Конвеєр: ingest → extract → parse → validate → рішення.
 * Нічого не зберігає — сховище передає викликач (§13.2).
 */
export async function processDocument(
  input: { name: string; bytes: Uint8Array; mime?: string },
  deps: PipelineDeps = {},
): Promise<PipelineResult> {
  const size = checkSize(input.bytes.length, deps.maxBytes);
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const mime = input.mime && input.mime !== "application/octet-stream"
    ? (detectMime(input.bytes, input.name) === "application/octet-stream" ? input.mime : detectMime(input.bytes, input.name))
    : detectMime(input.bytes, input.name);

  const base = { name: input.name, mime, bytes: input.bytes.length, sha256, pages: 0, text: "", parsed: null, validation: null, engine: "none" };

  if (!size.ok) {
    return { ...base, status: "rejected", reasons: [size.reason!] };
  }
  if (mime === "application/octet-stream") {
    return { ...base, status: "rejected", reasons: ["unsupported_mime"] };
  }

  let extracted: { text: string; pages: number; engine: string };
  try {
    extracted = await extractText({ bytes: input.bytes, mime, name: input.name }, deps);
  } catch (e) {
    return { ...base, status: "rejected", reasons: [`extract_failed:${(e as Error).message}`] };
  }

  if (!extracted.text.trim()) {
    return { ...base, ...extracted, status: "quarantined", reasons: ["empty_text"] };
  }

  const parsed = parseReceipt(extracted.text, deps.now ?? new Date());
  const validation = validateReceipt(parsed);
  const reasons = [...validation.reasons];

  return {
    ...base, pages: extracted.pages, text: extracted.text.slice(0, 20_000),
    engine: extracted.engine, parsed, validation,
    status: validation.status as PipelineStatus, reasons,
  };
}
