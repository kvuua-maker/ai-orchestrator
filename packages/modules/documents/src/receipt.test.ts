import { describe, it, expect } from "vitest";
import { parseReceipt, parseMoney, isValidEdrpou, needsConfirmation, isPlausibleDate } from "./receipt.js";
import { textLayerEngine, fixtureEngine } from "./ocr.js";

const FIXTURE = `ТОВ "СІЛЬПО-ФУД"
Магазин №42, м. Київ
ЄДРПОУ 40720196
Каса 3  03.11.2026 14:22
Молоко 2 x 42.50
Хліб 1 x 28.00
Всього 113.00
ПДВ 18.83
Картка ****1234`;

const TODAY = new Date("2026-11-12T00:00:00Z");

describe("parseMoney", () => {
  it("формати: пробіл-тисячі, кома, крапка", () => {
    expect(parseMoney("1 240,50")).toBe(1240.5);
    expect(parseMoney("25 999")).toBe(25999);
    expect(parseMoney("113.00")).toBe(113);
  });
  it("відкидає нуль і сміття", () => {
    expect(parseMoney("0")).toBeNull();
    expect(parseMoney("abc")).toBeNull();
  });
});

describe("ЄДРПОУ", () => {
  it("валідний код проходить контрольну суму", () => {
    // контрольна цифра обчислена за алгоритмом, а не вгадана
    expect(isValidEdrpou("40720196")).toBe(true);
  });
  it("кожна зміна останньої цифри ламає контроль", () => {
    expect(isValidEdrpou("40720197")).toBe(false);
  });
  it("невірна довжина/цифра — ні", () => {
    expect(isValidEdrpou("1234567")).toBe(false);
    expect(isValidEdrpou("12345670")).toBe(false);   // 12345678 був би валідним за сумою
  });
  it("контрольна сума не гарантує існування компанії", () => {
    expect(isValidEdrpou("12345678")).toBe(true);     // синтетичний, але арифметично коректний
  });
});

describe("parseReceipt", () => {
  it("витягує суму, дату, ЄДРПОУ, ПДВ", () => {
    const r = parseReceipt(FIXTURE, TODAY);
    expect(r.total.value).toBe(113);
    expect(r.date.value).toBe("2026-11-03");
    expect(r.edrpou.value).toBe("40720196");
    expect(r.vat.value).toBeCloseTo(18.83, 2);
    expect(r.quality).toBeGreaterThan(0.6);
  });

  it("перевіряє арифметику позицій", () => {
    const r = parseReceipt(FIXTURE, TODAY);
    expect(r.items.length).toBe(2);
    expect(r.issues.some((i) => i.startsWith("sum_mismatch"))).toBe(false);
  });

  it("ловить розбіжність суми", () => {
    const bad = FIXTURE.replace("Всього 113.00", "Всього 999.00");
    const r = parseReceipt(bad, TODAY);
    expect(r.issues.some((i) => i.startsWith("sum_mismatch"))).toBe(true);
  });

  it("дата в майбутньому → issue", () => {
    const future = FIXTURE.replace("03.11.2026", "01.01.2030");
    const r = parseReceipt(future, TODAY);
    expect(r.issues).toContain("date_out_of_range");
    expect(r.date.confidence).toBeLessThan(0.85);
  });

  it("без суми — fallback із низькою впевненістю", () => {
    const r = parseReceipt("ТОВ Тест\nКава 55.00", TODAY);
    expect(r.total.source).toBe("fallback");
    expect(r.total.confidence).toBeLessThan(0.85);
    expect(needsConfirmation(r)).toContain("total");
  });

  it("потребує підтвердження для полів < 0.85 або null", () => {
    const r = parseReceipt("просто текст без нічого", TODAY);
    const need = needsConfirmation(r);
    expect(need).toContain("total");
    expect(need).toContain("date");
  });

  it("повний чек не потребує підтвердження сум", () => {
    const r = parseReceipt(FIXTURE, TODAY);
    expect(needsConfirmation(r)).not.toContain("total");
  });
});

describe("date guard", () => {
  it("старіша за 5 років — невалідна", () => {
    expect(isPlausibleDate("2015-01-01", TODAY)).toBe(false);
    expect(isPlausibleDate("2026-11-03", TODAY)).toBe(true);
  });
});

describe("OCR engines", () => {
  it("text layer декодує plain text без OCR", async () => {
    const bytes = new TextEncoder().encode(FIXTURE);
    const out = await textLayerEngine.recognize({ bytes, mime: "text/plain" });
    expect(out.text).toContain("Всього");
    expect(out.confidence).toBe(1);
  });
  it("fixture engine повертає заданий текст", async () => {
    const out = await fixtureEngine(FIXTURE).recognize({ bytes: new Uint8Array(), mime: "image/jpeg" });
    expect(out.text).toBe(FIXTURE);
  });
  it("text layer відмовляє на зображенні (не робить вигляд, що працює)", async () => {
    await expect(textLayerEngine.recognize({ bytes: new Uint8Array(), mime: "image/png" })).rejects.toThrow();
  });
});

describe("parseMoney — крайові формати", () => {
  it("без розділювачів тисяч: 5000000.00", () => {
    expect(parseMoney("5000000.00")).toBe(5_000_000);
  });
  it("з розділювачами: 5 000 000,00", () => {
    expect(parseMoney("5 000 000,00")).toBe(5_000_000);
  });
  it("мішаний: 1 240.50", () => {
    expect(parseMoney("1 240.50")).toBe(1240.5);
  });
});
