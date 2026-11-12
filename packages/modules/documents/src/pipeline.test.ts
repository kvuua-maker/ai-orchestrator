import { describe, it, expect } from "vitest";
import { processDocument, extractPdfText } from "./pipeline.js";
import { detectMime, checkSize } from "./mime.js";
import { exportFile, toXlsx, toDocx, toPdf, asciiSafe } from "./exporters.js";
import { planFolders, slug } from "./folders.js";
import { fixtureEngine } from "./ocr.js";

const RECEIPT = `ТОВ "СІЛЬПО-ФУД"
ЄДРПОУ 40720196
Каса 3  03.11.2026 14:22
Молоко 2 x 42.50
Хліб 1 x 28.00
Всього 113.00
ПДВ 18.83`;
const TODAY = new Date("2026-11-12T00:00:00Z");
const enc = (s: string) => new TextEncoder().encode(s);

describe("detectMime", () => {
  it("PDF за магією, не за розширенням", () => {
    expect(detectMime(enc("%PDF-1.7 ..."), "file.txt")).toBe("application/pdf");
  });
  it("JPEG/PNG", () => {
    expect(detectMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(detectMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
  });
  it("текст", () => { expect(detectMime(enc("привіт"))).toBe("text/plain"); });
  it("DOCX/XLSX розрізняються за розширенням", () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    expect(detectMime(zip, "a.docx")).toContain("wordprocessingml");
    expect(detectMime(zip, "a.xlsx")).toContain("spreadsheetml");
  });
  it("ліміт розміру", () => {
    expect(checkSize(0).reason).toBe("empty_file");
    expect(checkSize(30 * 1024 * 1024).reason).toBe("file_too_large");
  });
});

describe("processDocument — текст", () => {
  it("повний чек → promoted", async () => {
    const r = await processDocument({ name: "receipt.txt", bytes: enc(RECEIPT) }, { now: TODAY });
    expect(r.mime).toBe("text/plain");
    expect(r.status).toBe("promoted");
    expect(r.parsed?.total.value).toBe(113);
    expect(r.sha256).toHaveLength(64);
  });
  it("сміття → rejected/quarantined, без падіння", async () => {
    const r = await processDocument({ name: "x.txt", bytes: enc("не чек") }, { now: TODAY });
    expect(["rejected", "quarantined"]).toContain(r.status);
    expect(r.reasons.length).toBeGreaterThan(0);
  });
  it("порожній файл → rejected empty_file", async () => {
    const r = await processDocument({ name: "e.txt", bytes: new Uint8Array() }, { now: TODAY });
    expect(r.status).toBe("rejected");
    expect(r.reasons).toContain("empty_file");
  });
  it("невідомий бінарний тип → rejected unsupported_mime", async () => {
    const r = await processDocument({ name: "b.bin", bytes: new Uint8Array([0, 1, 2, 3]) }, { now: TODAY });
    expect(r.status).toBe("rejected");
    expect(r.reasons).toContain("unsupported_mime");
  });
});

describe("processDocument — зображення через OCR", () => {
  it("мок-рушій дає текст, конвеєр його парсить", async () => {
    const r = await processDocument(
      { name: "scan.jpg", bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), mime: "image/jpeg" },
      { ocr: fixtureEngine(RECEIPT), now: TODAY },
    );
    expect(r.engine).toBe("fixture");
    expect(r.status).toBe("promoted");
    expect(r.parsed?.edrpou.value).toBe("40720196");
  });
  it("без OCR-рушія зображення не вдає успіх", async () => {
    const r = await processDocument({ name: "scan.jpg", bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) }, { now: TODAY });
    expect(r.status).toBe("rejected");
    expect(r.reasons[0]).toContain("image_requires_ocr");
  });
});

describe("PDF", () => {
  it("генерує PDF і витягує з нього текст назад", async () => {
    const { bytes } = await exportFile("pdf", { title: "Report", columns: ["A", "B"], rows: [{ A: "1", B: "2" }] });
    expect(bytes.slice(0, 4).toString()).toBe("%PDF");
    const { text, pages } = await extractPdfText(bytes);
    expect(pages).toBe(1);
    expect(text).toContain("Report");
  });

  it("PDF без текстового шару → помилка, а не порожній рядок", async () => {
    const r = await processDocument({ name: "empty.pdf", bytes: enc("%PDF-1.4\n%%EOF") }, { now: TODAY });
    expect(["rejected", "quarantined"]).toContain(r.status);
  });
});

describe("exporters", () => {
  const input = { title: "Звіт за листопад", columns: ["Дата", "Сума"], rows: [{ Дата: "2026-11-03", Сума: 113 }, { Дата: "2026-11-04", Сума: 87.5 }] };

  it("xlsx має сигнатуру ZIP і правильний mime", async () => {
    const f = await exportFile("xlsx", input);
    expect(f.bytes.slice(0, 2).toString()).toBe("PK");
    expect(f.mime).toContain("spreadsheetml");
    expect(await toXlsx(input)).toBeInstanceOf(Buffer);
  });
  it("docx має сигнатуру ZIP", async () => {
    const f = await exportFile("docx", input);
    expect(f.bytes.slice(0, 2).toString()).toBe("PK");
    expect(await toDocx(input)).toBeInstanceOf(Buffer);
  });
  it("pdf має сигнатуру %PDF", async () => {
    const f = await exportFile("pdf", input);
    expect(f.bytes.slice(0, 4).toString()).toBe("%PDF");
    expect(await toPdf(input)).toBeInstanceOf(Buffer);
  });
  it("ім'я файлу транслітерується, кирилиця не ламає PDF", () => {
    expect(asciiSafe("Звіт №42")).toContain("Zvit");
    expect(asciiSafe("Звіт")).not.toMatch(/[а-яіїєґ]/i);
  });
});

describe("folders", () => {
  const docs = [
    { key: "a", name: "receipt.pdf", date: "2026-11-03", merchant: "Сільпо", total: 113, sha256: "a".repeat(64) },
    { key: "b", name: "receipt.pdf", date: "2026-11-03", merchant: "Сільпо", total: 113, sha256: "b".repeat(64) },
    { key: "c", name: "scan.pdf", date: null, merchant: null, total: null, sha256: "c".repeat(64) },
  ];
  it("розкладає за рік/місяць/постачальник", () => {
    const { moves } = planFolders(docs);
    expect(moves[0]!.to).toMatch(/^documents\/2026\/11\/сільпо\//);   // кирилиця в теках — навмисно
    expect(moves[2]!.to).toContain("no-date");
  });
  it("колізії розв'язуються детермінованим суфіксом", () => {
    const { moves, collisions } = planFolders(docs);
    expect(collisions.length).toBe(1);
    expect(moves[1]!.to).toContain("bbbbbb");
  });
  it("slug прибирає небезпечні символи", () => {
    expect(slug("ТОВ «Ромашка» / ../etc")).not.toContain("..");
    expect(slug("")).toBe("unknown");
  });
});
