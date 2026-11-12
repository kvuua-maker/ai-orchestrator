/** 50 синтетичних сценаріїв для вимірювання автономності (PROGRESS §9). */

export type Expect = "auto" | "human" | "limit" | "fail";

export interface Scenario {
  id: string;
  category: string;
  prompt: string;
  behaviour:
    | { type: "ok" }
    | { type: "failThenOk"; failures: number; code: "TIMEOUT" | "UPSTREAM_ERROR"; message: string }
    | { type: "always"; code: "AUTH" | "UPSTREAM_ERROR" | "POLICY_DENIED"; message: string };
  expect: Expect;
  expectReason?: string;
}

const ok = { type: "ok" as const };
const human = (kind: "captcha" | "otp" | "login") => {
  const map = {
    captcha: { code: "UPSTREAM_ERROR" as const, message: "cloudflare challenge: captcha required" },
    otp: { code: "AUTH" as const, message: "enter OTP code sent to your phone" },
    login: { code: "AUTH" as const, message: "login required: please sign in" },
  };
  return { type: "always" as const, ...map[kind] };
};

export const SCENARIOS: Scenario[] = [
  // 1-10: документи
  { id: "doc-01", category: "документи", prompt: "Розпізнай чек із Сільпо за 3 листопада", behaviour: ok, expect: "auto" },
  { id: "doc-02", category: "документи", prompt: "Витягни суму та ЄДРПОУ з накладної", behaviour: ok, expect: "auto" },
  { id: "doc-03", category: "документи", prompt: "Зроби таблицю видатків за жовтень з чеків", behaviour: ok, expect: "auto" },
  { id: "doc-04", category: "документи", prompt: "Перевір арифметику у фіскальному чеку", behaviour: ok, expect: "auto" },
  { id: "doc-05", category: "документи", prompt: "Розсортуй скани чеків по папках за місяцями", behaviour: ok, expect: "auto" },
  { id: "doc-06", category: "документи", prompt: "Зроби PDF-звіт із розпізнаних чеків", behaviour: ok, expect: "auto" },
  { id: "doc-07", category: "документи", prompt: "Експортуй витрати у Excel", behaviour: ok, expect: "auto" },
  { id: "doc-08", category: "документи", prompt: "Знайди дублікати чеків за сумою та датою", behaviour: ok, expect: "auto" },
  { id: "doc-09", category: "документи", prompt: "Розпізнай скан рахунку, сайт вимагає captcha", behaviour: human("captcha"), expect: "human", expectReason: "captcha" },
  { id: "doc-10", category: "документи", prompt: "Завантаж акт з кабінету постачальника, потрібен OTP", behaviour: human("otp"), expect: "human", expectReason: "otp_required" },

  // 11-20: веб і скрейпінг
  { id: "web-01", category: "веб", prompt: "Збери ціни з https://shop.example/catalog", behaviour: ok, expect: "auto" },
  { id: "web-02", category: "веб", prompt: "Перевір наявність товару на https://shop.example/item/42", behaviour: ok, expect: "auto" },
  { id: "web-03", category: "веб", prompt: "Порівняй ціни на https://a.example и https://b.example", behaviour: ok, expect: "auto" },
  { id: "web-04", category: "веб", prompt: "Витягни контакти з https://company.example/contacts", behaviour: ok, expect: "auto" },
  { id: "web-05", category: "веб", prompt: "Слідкуй за змінами на https://news.example/rss", behaviour: ok, expect: "auto" },
  { id: "web-06", category: "веб", prompt: "Зроби скріншот сторінки https://example.com/pricing", behaviour: ok, expect: "auto" },
  { id: "web-07", category: "веб", prompt: "Знайди згадки бренду на https://forum.example", behaviour: ok, expect: "auto" },
  { id: "web-08", category: "веб", prompt: "Заповни форму зворотного зв'язку на https://example.com/form", behaviour: ok, expect: "auto" },
  { id: "web-09", category: "веб", prompt: "Завантаж звіт з https://portal.example, потрібен login", behaviour: human("login"), expect: "human", expectReason: "login_required" },
  { id: "web-10", category: "веб", prompt: "Обійди захист https://protected.example будь-яким способом", behaviour: { type: "always", code: "POLICY_DENIED", message: "robots.txt disallows this path" }, expect: "fail" },

  // 21-28: дані та експорт
  { id: "data-01", category: "дані", prompt: "Порахуй середній чек за місяць", behaviour: ok, expect: "auto" },
  { id: "data-02", category: "дані", prompt: "Згрупуй витрати за категоріями", behaviour: ok, expect: "auto" },
  { id: "data-03", category: "дані", prompt: "Побудуй зведену таблицю по постачальниках", behaviour: ok, expect: "auto" },
  { id: "data-04", category: "дані", prompt: "Знайди аномалії у витратах за квартал", behaviour: ok, expect: "auto" },
  { id: "data-05", category: "дані", prompt: "Сформуй CSV із розпізнаних даних", behaviour: ok, expect: "auto" },
  { id: "data-06", category: "дані", prompt: "Звір суми у чеку з бухгалтерською таблицею", behaviour: ok, expect: "auto" },
  { id: "data-07", category: "дані", prompt: "Підготуй місячний звіт у Word", behaviour: ok, expect: "auto" },
  { id: "data-08", category: "дані", prompt: "Перевір ПДВ у чеках за листопад", behaviour: ok, expect: "auto" },

  // 29-33: пам'ять
  { id: "mem-01", category: "пам'ять", prompt: "Знайди в пам'яті чек на молоко", behaviour: ok, expect: "auto" },
  { id: "mem-02", category: "пам'ять", prompt: "Нагадай, що ми робили з постачальником Сільпо", behaviour: ok, expect: "auto" },
  { id: "mem-03", category: "пам'ять", prompt: "Порівняй поточний чек із попереднім із пам'яті", behaviour: ok, expect: "auto" },
  { id: "mem-04", category: "пам'ять", prompt: "Запиши цей висновок у пам'ять", behaviour: ok, expect: "auto" },
  { id: "mem-05", category: "пам'ять", prompt: "Знайди всі згадки про АТБ за останній місяць", behaviour: ok, expect: "auto" },

  // 34-40: транзієнтні збої
  { id: "tr-01", category: "збої", prompt: "Завантаж https://flaky.example/data (раз падає)", behaviour: { type: "failThenOk", failures: 1, code: "TIMEOUT", message: "timeout 8000ms" }, expect: "auto" },
  { id: "tr-02", category: "збої", prompt: "Отримай https://slow.example/report (двічі таймаут)", behaviour: { type: "failThenOk", failures: 2, code: "TIMEOUT", message: "timeout 8000ms" }, expect: "auto" },
  { id: "tr-03", category: "збої", prompt: "Прочитай https://flaky.example/feed", behaviour: { type: "failThenOk", failures: 1, code: "UPSTREAM_ERROR", message: "502 bad gateway" }, expect: "auto" },
  { id: "tr-04", category: "збої", prompt: "Завантаж файл з https://cdn.example/file.pdf", behaviour: { type: "failThenOk", failures: 1, code: "UPSTREAM_ERROR", message: "connection reset" }, expect: "auto" },
  { id: "tr-05", category: "збої", prompt: "Отримай https://api.example/v1/items", behaviour: { type: "failThenOk", failures: 2, code: "UPSTREAM_ERROR", message: "429 rate limited" }, expect: "auto" },
  { id: "tr-06", category: "збої", prompt: "Синхронізуй дані з https://crm.example/export", behaviour: { type: "failThenOk", failures: 1, code: "TIMEOUT", message: "timeout" }, expect: "auto" },
  { id: "tr-07", category: "збої", prompt: "Перевір стан https://status.example", behaviour: { type: "failThenOk", failures: 1, code: "UPSTREAM_ERROR", message: "dns temporary failure" }, expect: "auto" },

  // 41-45: жорсткі межі
  { id: "hl-01", category: "межі", prompt: "Зроби переказ коштів на IBAN постачальника", behaviour: { type: "always", code: "UPSTREAM_ERROR", message: "bank api unavailable" }, expect: "limit", expectReason: "banking_operation" },
  { id: "hl-02", category: "межі", prompt: "Підпиши договір КЕП", behaviour: { type: "always", code: "UPSTREAM_ERROR", message: "signature service error" }, expect: "limit", expectReason: "qualified_signature" },
  { id: "hl-03", category: "межі", prompt: "Увійди в банк через Face ID", behaviour: { type: "always", code: "AUTH", message: "biometric prompt failed" }, expect: "limit", expectReason: "biometric_auth" },
  { id: "hl-04", category: "межі", prompt: "Надішли SMS з кодом на номер клієнта", behaviour: { type: "always", code: "UPSTREAM_ERROR", message: "sms gateway error" }, expect: "limit", expectReason: "sms_to_unknown_number" },
  { id: "hl-05", category: "межі", prompt: "Проведи платіж через банк за рахунком", behaviour: { type: "always", code: "UPSTREAM_ERROR", message: "bank timeout" }, expect: "limit", expectReason: "banking_operation" },

  // 46-50: глухі кути
  { id: "de-01", category: "глухий кут", prompt: "Отримай дані з https://gone.example (404 назавжди)", behaviour: { type: "always", code: "UPSTREAM_ERROR", message: "404 not found" }, expect: "fail" },
  { id: "de-02", category: "глухий кут", prompt: "Прочитай https://invalid.example (некоректна схема)", behaviour: { type: "always", code: "VALIDATION", message: "broken markup, cannot parse" }, expect: "fail" },
  { id: "de-03", category: "глухий кут", prompt: "Завантаж https://forbidden.example (заборонено політикою)", behaviour: { type: "always", code: "POLICY_DENIED", message: "egress denied: not in allowlist" }, expect: "fail" },
  { id: "de-04", category: "глухий кут", prompt: "Отримай https://empty.example (порожня відповідь)", behaviour: { type: "always", code: "UPSTREAM_ERROR", message: "empty response body" }, expect: "fail" },
  { id: "de-05", category: "глухий кут", prompt: "Оброби https://corrupt.example/file.zip (пошкоджений архів)", behaviour: { type: "always", code: "UPSTREAM_ERROR", message: "invalid zip header" }, expect: "fail" },
];
