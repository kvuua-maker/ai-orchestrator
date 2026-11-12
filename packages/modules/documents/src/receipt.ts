/** Схема українського фіскального чека + витяг полів (§13.5). */
export interface Field<T> {
  value: T | null;
  confidence: number;
  source: "label" | "pattern" | "fallback";
}

export interface ParsedReceipt {
  total: Field<number>;
  date: Field<string>;
  edrpou: Field<string>;
  vat: Field<number>;
  merchant: Field<string>;
  items: Array<{ name: string; qty: number; price: number }>;
  issues: string[];
  quality: number;
}

const MONEY = String.raw`(\d{1,3}(?:[ \u00A0]\d{3})*(?:[.,]\d{2})?)`;
const TOTAL_RE = new RegExp(String.raw`(?:всього|до сплати|сума|итого|total)\s*:?\s*${MONEY}`, "i");
const DATE_RE = /\b(\d{2})[.\-/](\d{2})[.\-/](\d{4})\b/;
const EDRPOU_RE = /\b(\d{8})\b/;
const VAT_RE = new RegExp(String.raw`(?:пдв|ндс|vat)\s*:?\s*${MONEY}`, "i");
const ITEM_RE = /^(.{3,60}?)\s+(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*[=]?\s*(\d+(?:[.,]\d+)?)?$/i;

export function parseMoney(raw: string): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[\s\u00A0]/g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 && n < 10_000_000 ? n : null;
}

/** ЄДРПОУ: контрольна сума за ваговими коефіцієнтами. */
export function isValidEdrpou(code: string): boolean {
  if (!/^\d{8}$/.test(code)) return false;
  const digits = code.split("").map(Number);
  const weightsByFirst: Record<number, number[]> = {
    1: [1, 2, 3, 4, 5, 6, 7], 2: [2, 3, 4, 5, 6, 7, 8], 3: [3, 4, 5, 6, 7, 8, 9],
    4: [4, 5, 6, 7, 8, 9, 10], 5: [5, 6, 7, 8, 9, 10, 11], 6: [6, 7, 8, 9, 10, 11, 12],
    7: [7, 8, 9, 10, 11, 12, 13], 8: [8, 9, 10, 11, 12, 13, 14], 9: [9, 10, 11, 12, 13, 14, 15],
  };
  const w = weightsByFirst[digits[0]!];
  if (!w) return false;
  const sum = w.reduce((s, wi, i) => s + wi * digits[i]!, 0) % 11;
  const check = sum === 10 ? 0 : sum;   // стандартне правило: 10 → 0
  return check === digits[7];
}

export function isPlausibleDate(iso: string, today = new Date()): boolean {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const fiveYearsAgo = new Date(today.getFullYear() - 5, today.getMonth(), today.getDate());
  return d <= today && d >= fiveYearsAgo;
}

export function parseReceipt(text: string, today = new Date()): ParsedReceipt {
  const issues: string[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  let total: Field<number> = { value: null, confidence: 0, source: "label" };
  const tm = text.match(TOTAL_RE);
  if (tm) {
    const v = parseMoney(tm[1]!);
    if (v !== null) total = { value: v, confidence: 0.97, source: "label" };
    else issues.push("total_found_but_unparsable");
  } else {
    // fallback: найбільша сума в тексті
    const all = [...text.matchAll(new RegExp(MONEY, "g"))].map((m) => parseMoney(m[1]!)).filter((x): x is number => x !== null);
    if (all.length) { total = { value: Math.max(...all), confidence: 0.55, source: "fallback" }; issues.push("total_by_fallback"); }
    else issues.push("total_missing");
  }

  let date: Field<string> = { value: null, confidence: 0, source: "pattern" };
  const dm = text.match(DATE_RE);
  if (dm) {
    const iso = `${dm[3]}-${dm[2]}-${dm[1]}`;
    date = { value: iso, confidence: isPlausibleDate(iso, today) ? 0.95 : 0.6, source: "pattern" };
    if (!isPlausibleDate(iso, today)) issues.push("date_out_of_range");
  } else issues.push("date_missing");

  let edrpou: Field<string> = { value: null, confidence: 0, source: "pattern" };
  for (const m of text.matchAll(new RegExp(EDRPOU_RE, "g"))) {
    if (isValidEdrpou(m[1]!)) { edrpou = { value: m[1]!, confidence: 0.9, source: "pattern" }; break; }
  }
  if (!edrpou.value) issues.push("edrpou_missing_or_invalid");

  let vat: Field<number> = { value: null, confidence: 0, source: "label" };
  const vm = text.match(VAT_RE);
  if (vm) { const v = parseMoney(vm[1]!); if (v !== null) vat = { value: v, confidence: 0.92, source: "label" }; }

  const merchantLine = lines.find((l) => /тов|фоп|llc|магазин|store/i.test(l));
  const merchant: Field<string> = merchantLine
    ? { value: merchantLine.slice(0, 80), confidence: 0.7, source: "pattern" }
    : { value: null, confidence: 0, source: "fallback" };

  const items: ParsedReceipt["items"] = [];
  for (const l of lines) {
    const m = l.match(ITEM_RE);
    if (m) {
      const qty = Number(m[2]!.replace(",", "."));
      const price = Number(m[3]!.replace(",", "."));
      if (qty > 0 && price > 0) items.push({ name: m[1]!, qty, price });
    }
  }
  if (items.length && total.value !== null) {
    const sum = items.reduce((s, i) => s + i.qty * i.price, 0);
    if (Math.abs(sum - total.value) > 0.02) issues.push(`sum_mismatch:${sum.toFixed(2)}!=${total.value.toFixed(2)}`);
  }
  if (vat.value !== null && total.value !== null) {
    const expected = Math.round((total.value * 20 / 120) * 100) / 100;
    if (Math.abs(expected - vat.value) > Math.max(0.02, total.value * 0.01)) issues.push("vat_mismatch");
  }

  const fields = [total, date, edrpou, vat, merchant];
  const quality = Math.round((fields.reduce((s, f) => s + f.confidence, 0) / fields.length) * 100) / 100;
  return { total, date, edrpou, vat, merchant, items, issues, quality };
}

/** Гейт §13.7: генерація заборонена, поки є поля з confidence < 0.85. */
export function needsConfirmation(r: ParsedReceipt, threshold = 0.85): string[] {
  const out: string[] = [];
  for (const [k, f] of Object.entries({ total: r.total, date: r.date, edrpou: r.edrpou, vat: r.vat })) {
    if (f.confidence > 0 && f.confidence < threshold) out.push(k);
    if (f.value === null) out.push(k);
  }
  return [...new Set(out)];
}
