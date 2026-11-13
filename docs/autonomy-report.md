# Автономність: вимірювання на 50 сценаріях

Дата: 2026-11-13
Середовище: детерміновані моки інструментів, реальний Router (евристика) + Planner + Scheduler + Handoff.

## Підсумок

| Метрика | Значення |
|---|---|
| Автономне виконання (де очікувалось) | **36/36 = 100%** |
| Коректна ескалація (handoff/межа) | 8/8 = 100% |
| Коректне падіння (глухий кут) | 6/6 = 100% |
| Загальна правильність рішення | 50/50 = 100% |
| Середній час сценарію | 145 мс |

## Деталі

| ID | Категорія | Очікування | Факт | Причина | ✓ |
|---|---|---|---|---|---|
| doc-01 | документи | auto | done | — | ✓ |
| doc-02 | документи | auto | done | — | ✓ |
| doc-03 | документи | auto | done | — | ✓ |
| doc-04 | документи | auto | done | — | ✓ |
| doc-05 | документи | auto | done | — | ✓ |
| doc-06 | документи | auto | done | — | ✓ |
| doc-07 | документи | auto | done | — | ✓ |
| doc-08 | документи | auto | done | — | ✓ |
| doc-09 | документи | human | blocked | captcha | ✓ |
| doc-10 | документи | human | blocked | otp_required | ✓ |
| web-01 | веб | auto | done | — | ✓ |
| web-02 | веб | auto | done | — | ✓ |
| web-03 | веб | auto | done | — | ✓ |
| web-04 | веб | auto | done | — | ✓ |
| web-05 | веб | auto | done | — | ✓ |
| web-06 | веб | auto | done | — | ✓ |
| web-07 | веб | auto | done | — | ✓ |
| web-08 | веб | auto | done | — | ✓ |
| web-09 | веб | human | blocked | login_required | ✓ |
| web-10 | веб | fail | failed | policy_denied | ✓ |
| data-01 | дані | auto | done | — | ✓ |
| data-02 | дані | auto | done | — | ✓ |
| data-03 | дані | auto | done | — | ✓ |
| data-04 | дані | auto | done | — | ✓ |
| data-05 | дані | auto | done | — | ✓ |
| data-06 | дані | auto | done | — | ✓ |
| data-07 | дані | auto | done | — | ✓ |
| data-08 | дані | auto | done | — | ✓ |
| mem-01 | пам'ять | auto | done | — | ✓ |
| mem-02 | пам'ять | auto | done | — | ✓ |
| mem-03 | пам'ять | auto | done | — | ✓ |
| mem-04 | пам'ять | auto | done | — | ✓ |
| mem-05 | пам'ять | auto | done | — | ✓ |
| tr-01 | збої | auto | done | — | ✓ |
| tr-02 | збої | auto | done | — | ✓ |
| tr-03 | збої | auto | done | — | ✓ |
| tr-04 | збої | auto | done | — | ✓ |
| tr-05 | збої | auto | done | — | ✓ |
| tr-06 | збої | auto | done | — | ✓ |
| tr-07 | збої | auto | done | — | ✓ |
| hl-01 | межі | limit | blocked | banking_operation | ✓ |
| hl-02 | межі | limit | blocked | qualified_signature | ✓ |
| hl-03 | межі | limit | blocked | biometric_auth | ✓ |
| hl-04 | межі | limit | blocked | sms_to_unknown_number | ✓ |
| hl-05 | межі | limit | blocked | banking_operation | ✓ |
| de-01 | глухий кут | fail | failed | attempts_exhausted | ✓ |
| de-02 | глухий кут | fail | failed | attempts_exhausted | ✓ |
| de-03 | глухий кут | fail | failed | policy_denied | ✓ |
| de-04 | глухий кут | fail | failed | attempts_exhausted | ✓ |
| de-05 | глухий кут | fail | failed | attempts_exhausted | ✓ |

## Обмеження цього виміру

- Моки інструментів: перевіряється **логіка рушія** (маршрутизація, планування, ретраї, класифікація, handoff),
  а не якість живої LLM-моделі чи реальних сайтів.
- Реальна автономність із DeepSeek буде **нижчою**: план від моделі може бути некоректним,
  а зовнішні сайти — змінюватись.
- Цифра 100% означає: «рушій не заважає виконати задачу там, де це можливо».
