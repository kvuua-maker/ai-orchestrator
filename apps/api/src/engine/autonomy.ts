/** Детекція глухих кутів і жорстких меж (§4.16–4.18). */

export type DeadEndKind = "retryable" | "needs_human" | "hard_limit" | "dead_end";

export interface DeadEndVerdict {
  kind: DeadEndKind;
  reason: string;
  message: string;
  /** Питання людині — тільки для needs_human/hard_limit. */
  question?: string;
  options?: Array<{ id: string; label: string }>;
  /** Конкретна альтернатива для hard_limit (§4.18). */
  alternative?: string;
}

const HUMAN_MARKERS: Array<{ re: RegExp; reason: string; question: string }> = [
  { re: /captcha|recaptcha|hcaptcha|cloudflare challenge/i, reason: "captcha", question: "Сайт вимагає проходження CAPTCHA. Пройдіть її у вікні браузера й натисніть «Продовжити»." },
  { re: /\botp\b|one[- ]time (code|password)|2fa|двофактор|код підтвердження/i, reason: "otp_required", question: "Потрібен одноразовий код. Введіть його — він не зберігається." },
  { re: /login|sign in|увійдіть|пароль|password/i, reason: "login_required", question: "Потрібен вхід у акаунт. Увійдіть у браузері й натисніть «Продовжити»." },
  { re: /confirm (payment|transfer)|підтвердіть (платіж|переказ)/i, reason: "payment_confirmation", question: "Підтвердіть платіж у банківському застосунку." },
];

/** Жорсткі межі: агент не робить це ніколи, лише пропонує альтернативу (§4.18). */
const HARD_LIMITS: Array<{ re: RegExp; reason: string; alternative: string }> = [
  { re: /банк|bank|iban|swift|переказ коштів/i, reason: "banking_operation",
    alternative: "Агент підготує платіжне доручення (PDF/CSV) — підписуєте ви у своєму банку." },
  { re: /кеп|кваліфікован\w+ підпис|digital signature/i, reason: "qualified_signature",
    alternative: "Агент збереже документ і покаже, де підписати; КЕП залишається у вас." },
  { re: /sms.*(номер|number)|код на номер/i, reason: "sms_to_unknown_number",
    alternative: "Код надходить лише на ваш номер — агент не може його перехопити." },
  { re: /біометр|biometric|face ?id|touch ?id|passkey/i, reason: "biometric_auth",
    alternative: "Авторизація на пристрої — агент не має доступу до біометрії." },
];

export function detectHardLimit(goalText: string): DeadEndVerdict | null {
  for (const hl of HARD_LIMITS) {
    if (hl.re.test(goalText)) {
      return {
        kind: "hard_limit", reason: hl.reason,
        message: "Цю дію агент виконати не може — це жорстка межа безпеки.",
        alternative: hl.alternative,
      };
    }
  }
  return null;
}

export interface FailureInput {
  tool: string;
  error: { code: string; message: string; retryable: boolean };
  attempts: number;
  maxAttempts?: number;
  goalText?: string;
}

/** Класифікація невдачі: що робити далі (§21.2). */
export function classifyFailure(input: FailureInput): DeadEndVerdict {
  const { error, attempts, tool } = input;
  const maxAttempts = input.maxAttempts ?? 3;

  if (input.goalText) {
    const hl = detectHardLimit(input.goalText);
    if (hl) return hl;
  }

  for (const m of HUMAN_MARKERS) {
    if (m.re.test(error.message) || m.re.test(error.code)) {
      return {
        kind: "needs_human", reason: m.reason, message: error.message,
        question: m.question,
        options: [
          { id: "done", label: "Готово, продовжити" },
          { id: "skip", label: "Пропустити цей крок" },
          { id: "abort", label: "Зупинити задачу" },
        ],
      };
    }
  }

  if (error.code === "POLICY_DENIED") {
    return { kind: "dead_end", reason: "policy_denied", message: error.message };
  }
  if (error.retryable && attempts < maxAttempts) {
    return { kind: "retryable", reason: "transient", message: error.message };
  }
  if (attempts >= maxAttempts) {
    return {
      kind: "dead_end", reason: "attempts_exhausted",
      message: `${tool}: ${maxAttempts} спроб вичерпано — ${error.message}`,
    };
  }
  return { kind: "dead_end", reason: error.code.toLowerCase(), message: error.message };
}

/** Захист від циклів: однакова дія з однаковим результатом не повторюється вічно. */
export class LoopGuard {
  private seen = new Map<string, number>();
  constructor(private readonly limit = 2) {}

  /** true = продовжувати не можна, це глухий кут. */
  observe(key: string): boolean {
    const n = (this.seen.get(key) ?? 0) + 1;
    this.seen.set(key, n);
    return n > this.limit;
  }

  reset(): void { this.seen.clear(); }
  get size(): number { return this.seen.size; }
}

/** Політика ретраїв: експоненційний backoff із стелею (§21.3). */
export function retryDelayMs(attempt: number, base = 250, cap = 8_000): number {
  return Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
}
