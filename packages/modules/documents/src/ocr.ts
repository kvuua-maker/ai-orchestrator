/** Рушій OCR — інтерфейс. Реалізації підключаються, ядро їх не знає (§31.2). */
export interface OcrEngine {
  readonly name: string;
  /** Повертає текст сторінок. Для PDF із текстовим шаром OCR не потрібен. */
  recognize(input: { bytes: Uint8Array; mime: string; lang?: string[] }): Promise<{ text: string; pages: number; confidence: number }>;
}

/** Текстовий шар: швидко, безкоштовно, без OCR (§13.4 — 90% бізнес-документів). */
export const textLayerEngine: OcrEngine = {
  name: "text-layer",
  async recognize({ bytes, mime }) {
    if (mime.startsWith("text/")) {
      const text = new TextDecoder().decode(bytes);
      return { text, pages: 1, confidence: 1 };
    }
    throw new Error("text-layer engine supports text/* only");
  },
};

/** Тестовий/офлайновий рушій: повертає наперед відомий текст (фікстури в CI). */
export function fixtureEngine(text: string): OcrEngine {
  return { name: "fixture", async recognize() { return { text, pages: 1, confidence: 0.9 }; } };
}

/**
 * Tesseract підключається опційно (важкий WASM + мовні дані).
 * Без нього — чесна помилка, а не мовчазний нуль.
 */
export async function createTesseractEngine(langs = ["ukr", "eng"]): Promise<OcrEngine> {
  // @ts-expect-error — опційна залежність, встановлюється за потреби
  const tesseract: any = await import("tesseract.js");
  return {
    name: "tesseract",
    async recognize({ bytes }) {
      const worker = await tesseract.createWorker(langs);
      try {
        const { data } = await worker.recognize(Buffer.from(bytes));
        return { text: String(data.text ?? ""), pages: 1, confidence: Number(data.confidence ?? 0) / 100 };
      } finally { await worker.terminate(); }
    },
  };
}

/** Вибір рушія за типом входу (§13.4.1). */
export async function pickEngine(mime: string): Promise<OcrEngine> {
  if (mime.startsWith("text/") || mime === "application/pdf") return textLayerEngine;
  return createTesseractEngine();
}
