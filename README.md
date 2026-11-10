# Universal RPA Agent

SaaS-платформа: користувач пише задачу в чат — система планує її, виконує реальними інструментами
(браузер, пісочниця, shell, HTTP, CRM API) і повертає артефакти.

Позиціювання: **не «AI-чат», а AI-працівник**, який закриває бізнес-процеси — CRM, соцмережі,
парсинг маркетплейсів, керування доступами до акаунтів.

> **Статус: архітектурна фаза.** Коду застосунку ще немає. Див. [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Що всередині архітектури

| Частина | Розділи | Про що |
|---|---|---|
| **I — рушій** | §1–§12 | Агенти, браузер і анти-бот, інструменти, пам'ять, SaaS/білінг, безпека, дорожня карта |
| **II — бізнес-модулі** | §14–§18 | CRM, соцмережі, парсинг, Account Vault, Affiliate |
| **III — аудит і план** | §19–§24 | 20 знайдених дір, ідемпотентність/outbox, стійкість, якість даних, відсутні компоненти, план побудови |
| **Додатки** | §25 | ADR, схема подій, контракти промптів, глосарій, джерела |

## Структура репозиторію (цільова)

```
apps/
  web/          Next.js: чат, run timeline, артефакти, approvals, live-браузер
  api/          Fastify control plane: auth, tenants, billing, runs, webhooks
  worker/       Agent runtime + tool executors (масштабується горизонтально)
packages/
  agent-core/   Planner, executor loop, run state machine, model router
  tools/        Tool registry + інструменти (browser, shell, http, ...)
  modules/      Бізнес-модулі Частини II
    crm/        Канонічна модель + адаптери KeyCRM/Bitrix24/LP-CRM/SalesDrive
    social/     Telegram, YouTube, Instagram, TikTok (офіційні API)
    scraping/   JSON-LD-first екстрактори для маркетплейсів
    vault/      Account Vault: шифрування, TOTP, grants
    affiliate/  CPA-мережі, deep link, postback, облік доходу
  shared/       Типи, zod-схеми, контракти подій
infra/
  docker/       Локальний dev (postgres, redis, minio, browser-runner, libreoffice)
  terraform/    Хмарна інфраструктура (пізніше)
docs/
  adr/          Architecture Decision Records
  research/     Дослідницькі нотатки до ARCHITECTURE.md
```

## З чого почати

1. [`ARCHITECTURE.md`](./ARCHITECTURE.md) §11 — 12-тижневий план за **$0** і тригери витрат.
2. [`ARCHITECTURE.md`](./ARCHITECTURE.md) §1.5 — що змінює розширення до Universal RPA Agent.
3. `docs/adr/` — рішення, по одному на файл, незмінні після прийняття.

## Локальний запуск (після віхи 2)

```bash
pnpm install
cp .env.example .env      # за замовчуванням — $0-стек (безкоштовні провайдери)
pnpm db:up                # postgres + redis + minio + browser-runner
pnpm dev
```

## Непорушні правила

- Кожен тенант ізольований на рівні даних (RLS) **і** обчислень (власний namespace пісочниці).
- Секрети ніколи не потрапляють у промпт. Інструменти отримують capability handle, не значення.
- Недовірений вміст ніколи не змішується з привілейованим контекстом (Dual-LLM).
- Кожен виклик інструмента аудитується: хто, що, який run, хеш аргументів, результат.
- **Тільки офіційні API платформ.** Масове створення акаунтів, обхід банів і спам-розсилки — поза
  скоупом продукту (§15.1).
