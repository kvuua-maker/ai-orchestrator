import { describe, it, expect } from "vitest";
import { parseReceipt } from "./receipt.js";
import { validateReceipt, defaultPolicy } from "./validate.js";

const GOOD = `ТОВ "СІЛЬПО-ФУД"
ЄДРПОУ 40720196
Каса 3  03.11.2026 14:22
Молоко 2 x 42.50
Хліб 1 x 28.00
Всього 113.00
ПДВ 18.83`;
const TODAY = new Date("2026-11-12T00:00:00Z");

describe("validateReceipt", () => {
  it("повний коректний чек → promoted", () => {
    const v = validateReceipt(parseReceipt(GOOD, TODAY));
    expect(v.status).toBe("promoted");
    expect(v.needsConfirmation).toEqual([]);
  });

  it("без суми → rejected", () => {
    const v = validateReceipt(parseReceipt("просто текст", TODAY));
    expect(v.status).toBe("rejected");
    expect(v.reasons).toContain("total_missing");
  });

  it("розбіжність арифметики → quarantined", () => {
    const v = validateReceipt(parseReceipt(GOOD.replace("113.00", "999.00"), TODAY));
    expect(v.status).toBe("quarantined");
    expect(v.reasons).toContain("arithmetic_mismatch");
  });

  it("дата в майбутньому → quarantined", () => {
    const v = validateReceipt(parseReceipt(GOOD.replace("03.11.2026", "01.01.2030"), TODAY));
    expect(v.status).toBe("quarantined");
    expect(v.reasons).toContain("date_out_of_range");
  });

  it("сума вище ліміту автообробки → quarantined", () => {
    const big = GOOD.replace("Всього 113.00", "Всього 5000000.00").replace("Молоко 2 x 42.50", "").replace("Хліб 1 x 28.00", "");
    const v = validateReceipt(parseReceipt(big, TODAY), { ...defaultPolicy, maxAutoTotal: 1_000_000 });
    expect(v.status).toBe("quarantined");
    expect(v.reasons).toContain("amount_above_auto_limit");
  });

  it("низька впевненість у полі → quarantined + поле в списку", () => {
    const noEdrpou = GOOD.replace("ЄДРПОУ 40720196", "");
    const v = validateReceipt(parseReceipt(noEdrpou, TODAY));
    expect(v.status).toBe("quarantined");
    expect(v.needsConfirmation.length).toBeGreaterThan(0);
  });
});
