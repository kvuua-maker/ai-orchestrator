import type { ParsedReceipt } from "./receipt.js";

export type ValidationStatus = "promoted" | "quarantined" | "rejected";

export interface ValidationResult {
  status: ValidationStatus;
  quality: number;
  /** Причини рішення — для UI і для аудиту (§22.1). */
  reasons: string[];
  /** Поля, які людина має підтвердити перед генерацією (§13.7). */
  needsConfirmation: string[];
}

export interface ValidationPolicy {
  minQuality: number;
  confirmationThreshold: number;
  /** Сума, вище якої документ не проходить без людини. */
  maxAutoTotal: number;
}

export const defaultPolicy: ValidationPolicy = { minQuality: 0.6, confirmationThreshold: 0.85, maxAutoTotal: 1_000_000 };

/**
 * Канон заповнюється лише тим, що пройшло перевірку (§22.1):
 * rejected — немає суми; quarantined — є питання; promoted — можна вірити.
 */
export function validateReceipt(r: ParsedReceipt, policy: ValidationPolicy = defaultPolicy): ValidationResult {
  const reasons: string[] = [];
  const needsConfirmation: string[] = [];

  for (const [k, f] of Object.entries({ total: r.total, date: r.date, edrpou: r.edrpou, vat: r.vat })) {
    if (f.value === null) needsConfirmation.push(k);
    else if (f.confidence < policy.confirmationThreshold) needsConfirmation.push(k);
  }

  if (r.total.value === null) {
    return { status: "rejected", quality: r.quality, reasons: ["total_missing"], needsConfirmation };
  }
  if (r.issues.includes("date_missing")) reasons.push("date_missing");
  if (r.issues.some((i) => i.startsWith("sum_mismatch"))) reasons.push("arithmetic_mismatch");
  if (r.issues.includes("vat_mismatch")) reasons.push("vat_mismatch");
  if (r.issues.includes("date_out_of_range")) reasons.push("date_out_of_range");
  if (r.issues.includes("total_by_fallback")) reasons.push("total_by_fallback");
  if (r.total.value > policy.maxAutoTotal) reasons.push("amount_above_auto_limit");
  if (r.quality < policy.minQuality) reasons.push("low_quality");

  const blocking = reasons.some((x) =>
    ["arithmetic_mismatch", "date_out_of_range", "low_quality", "amount_above_auto_limit"].includes(x));

  if (blocking) return { status: "quarantined", quality: r.quality, reasons, needsConfirmation };
  if (needsConfirmation.length) return { status: "quarantined", quality: r.quality, reasons: [...reasons, "needs_confirmation"], needsConfirmation };
  return { status: "promoted", quality: r.quality, reasons, needsConfirmation: [] };
}
